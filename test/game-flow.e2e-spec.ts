import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_KEYS } from '../src/redis/redis.keys';
import { RoomStatus } from '../src/rooms/enums/room-status.enum';
import { AddressInfo } from 'net';
import { Server } from 'http';

jest.setTimeout(30000);

interface CreateRoomResponse {
  success: boolean;
  roomCode: string;
  reconnectToken: string;
  hostId: string;
}

interface JoinRoomResponse {
  success: boolean;
  roomCode: string;
  reconnectToken: string;
  playerId: string;
}

const MINIMAL_STROKES = [
  {
    color: '#000000',
    brushSize: 2,
    points: [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ],
  },
];

function waitForEvent<T>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function connectSocket(port: number, token: string): Promise<ClientSocket> {
  const wsUrl = `ws://127.0.0.1:${port}/game`;

  return new Promise((resolve, reject) => {
    const socket: ClientSocket = io(wsUrl, {
      transports: ['websocket'],
      forceNew: true,
      query: { token },
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connection timed out'));
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(err);
    });
  });
}

describe('Game Flow Pipeline (E2E)', () => {
  let app: INestApplication;
  let redisService: RedisService;
  let httpServer: Server;
  let serverPort: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    httpServer = app.getHttpServer() as Server;
    redisService = app.get<RedisService>(RedisService);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const address = httpServer.address() as AddressInfo;
        serverPort = address.port;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    await redisService.getClient().flushdb();
  });

  afterAll(async () => {
    await redisService.getClient().flushdb();
    await app.close();
  });

  async function setupTwoPlayerRoom(): Promise<{
    roomCode: string;
    hostSocket: ClientSocket;
    guestSocket: ClientSocket;
    hostId: string;
    guestId: string;
  }> {
    const createRes = await request(httpServer)
      .post('/api/v1/rooms/create')
      .expect(201);
    const createBody = createRes.body as CreateRoomResponse;

    const joinRes = await request(httpServer)
      .post('/api/v1/rooms/join')
      .send({ roomCode: createBody.roomCode, username: 'Guest' })
      .expect(200);
    const joinBody = joinRes.body as JoinRoomResponse;

    const hostSocket = await connectSocket(serverPort, createBody.reconnectToken);
    const guestSocket = await connectSocket(serverPort, joinBody.reconnectToken);

    return {
      roomCode: createBody.roomCode,
      hostSocket,
      guestSocket,
      hostId: createBody.hostId,
      guestId: joinBody.playerId,
    };
  }

  it('should broadcast server-owned clocks on round start and gallery canvas', async () => {
    const { roomCode, hostSocket, guestSocket } = await setupTwoPlayerRoom();

    hostSocket.emit('v1:host:update_settings', {
      timerDuration: 60,
      totalRounds: 1,
      theme: 'RANDOM',
    });

    hostSocket.emit('v1:host:start_game');

    const roundStarted = await waitForEvent<{
      roundEndTimestamp: number;
      serverTime: number;
    }>(hostSocket, 'v1:game:round_started');

    expect(roundStarted.roundEndTimestamp).toBeGreaterThan(roundStarted.serverTime);

    hostSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });
    guestSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });

    const nextCanvas = await waitForEvent<{
      galleryEndTimestamp: number;
      serverTime: number;
    }>(hostSocket, 'v1:gallery:next_canvas');

    expect(nextCanvas.galleryEndTimestamp).toBeGreaterThan(
      nextCanvas.serverTime,
    );

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  async function completeGalleryVoting(
    hostSocket: ClientSocket,
    guestSocket: ClientSocket,
    canvases: number,
  ): Promise<void> {
    for (let canvas = 0; canvas < canvases; canvas++) {
      await waitForEvent(hostSocket, 'v1:gallery:next_canvas', 10000);
      guestSocket.emit('v1:vote:cast_stars', { stars: 7 });
      hostSocket.emit('v1:vote:cast_stars', { stars: 9 });
    }
  }

  it('should advance gallery immediately once the last active voter submits stars', async () => {
    const { hostSocket, guestSocket } = await setupTwoPlayerRoom();

    hostSocket.emit('v1:host:update_settings', {
      timerDuration: 60,
      totalRounds: 1,
      theme: 'RANDOM',
    });
    hostSocket.emit('v1:host:start_game');
    await waitForEvent(hostSocket, 'v1:game:round_started');

    hostSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });
    guestSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });

    const roundCompletePromise = waitForEvent<{
      standings: Array<{ playerId: string; score: number; rank: number }>;
    }>(hostSocket, 'v1:game:round_complete', 15000);

    await completeGalleryVoting(hostSocket, guestSocket, 2);

    const roundComplete = await roundCompletePromise;
    expect(roundComplete.standings.length).toBeGreaterThan(0);
    expect(roundComplete.standings.some((entry) => entry.score > 0)).toBe(true);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('should recalculate gallery completion when a player disconnects mid-voting', async () => {
    const createRes = await request(httpServer)
      .post('/api/v1/rooms/create')
      .expect(201);
    const createBody = createRes.body as CreateRoomResponse;

    const guestOne = await request(httpServer)
      .post('/api/v1/rooms/join')
      .send({ roomCode: createBody.roomCode, username: 'GuestOne' })
      .expect(200);
    const guestTwo = await request(httpServer)
      .post('/api/v1/rooms/join')
      .send({ roomCode: createBody.roomCode, username: 'GuestTwo' })
      .expect(200);

    const hostSocket = await connectSocket(serverPort, createBody.reconnectToken);
    const guestOneSocket = await connectSocket(
      serverPort,
      (guestOne.body as JoinRoomResponse).reconnectToken,
    );
    const guestTwoSocket = await connectSocket(
      serverPort,
      (guestTwo.body as JoinRoomResponse).reconnectToken,
    );

    hostSocket.emit('v1:host:update_settings', {
      timerDuration: 60,
      totalRounds: 1,
      theme: 'RANDOM',
    });
    hostSocket.emit('v1:host:start_game');
    await waitForEvent(hostSocket, 'v1:game:round_started');

    hostSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });
    guestOneSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });
    guestTwoSocket.emit('v1:canvas:submit_drawing', {
      strokes: MINIMAL_STROKES,
    });

    await waitForEvent(hostSocket, 'v1:gallery:next_canvas', 15000);

    hostSocket.emit('v1:vote:cast_stars', { stars: 5 });
    guestOneSocket.emit('v1:vote:cast_stars', { stars: 6 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    guestTwoSocket.disconnect();

    const nextCanvas = await waitForEvent(
      hostSocket,
      'v1:gallery:next_canvas',
      15000,
    );
    expect(nextCanvas).toBeDefined();

    hostSocket.disconnect();
    guestOneSocket.disconnect();
  });

  it('should emit match_over standings and reset to lobby on play again', async () => {
    const { roomCode, hostSocket, guestSocket } = await setupTwoPlayerRoom();

    hostSocket.emit('v1:host:update_settings', {
      timerDuration: 60,
      totalRounds: 1,
      theme: 'RANDOM',
    });
    hostSocket.emit('v1:host:start_game');
    await waitForEvent(hostSocket, 'v1:game:round_started');

    hostSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });
    guestSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });

    await completeGalleryVoting(hostSocket, guestSocket, 2);
    await waitForEvent(hostSocket, 'v1:game:round_complete', 15000);

    hostSocket.emit('v1:debug:advance_phase');
    await waitForEvent(hostSocket, 'v1:game:phase_changed', 8000);

    hostSocket.emit('v1:debug:advance_phase');

    const matchOver = await waitForEvent<{
      podium: Array<{ rank: number; playerId: string }>;
      standings: Array<{ rank: number; playerId: string }>;
    }>(hostSocket, 'v1:game:match_over', 8000);

    expect(matchOver.podium[0]?.rank).toBe(1);
    expect(matchOver.standings.length).toBeGreaterThan(0);

    const lobbyResetPromise = waitForEvent<{ status: RoomStatus }>(
      hostSocket,
      'v1:game:lobby_reset',
    );

    hostSocket.emit('v1:host:trigger_play_again', { confirm: true });
    const lobbyReset = await lobbyResetPromise;

    expect(lobbyReset.status).toBe(RoomStatus.LOBBY);

    const roomState = await redisService
      .getClient()
      .hgetall(REDIS_KEYS.ROOM_STATE(roomCode));
    expect(roomState.status).toBe(RoomStatus.LOBBY);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });
});
