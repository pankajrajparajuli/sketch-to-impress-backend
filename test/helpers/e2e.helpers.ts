import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../../src/app.module';
import { RedisService } from '../../src/redis/redis.service';
import { AddressInfo } from 'net';
import { Server } from 'http';

export interface CreateRoomResponse {
  success: boolean;
  roomCode: string;
  reconnectToken: string;
  hostId: string;
}

export interface JoinRoomResponse {
  success: boolean;
  roomCode: string;
  reconnectToken: string;
  playerId: string;
}

export const MINIMAL_STROKES = [
  {
    color: '#000000',
    brushSize: 2,
    points: [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ],
  },
];

export const ALT_STROKES = [
  {
    color: '#ff0000',
    brushSize: 4,
    points: [
      { x: 10, y: 10 },
      { x: 20, y: 20 },
    ],
  },
];

export interface E2EContext {
  app: INestApplication;
  redisService: RedisService;
  httpServer: Server;
  serverPort: number;
}

export async function bootstrapE2EApp(): Promise<E2EContext> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();

  const httpServer = app.getHttpServer() as Server;
  const redisService = app.get<RedisService>(RedisService);

  const serverPort = await new Promise<number>((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address() as AddressInfo;
      resolve(address.port);
    });
  });

  return { app, redisService, httpServer, serverPort };
}

export async function teardownE2EApp(ctx: E2EContext): Promise<void> {
  await ctx.redisService.getClient().flushdb();
  await ctx.app.close();
}

export async function createRoom(
  httpServer: Server,
): Promise<CreateRoomResponse> {
  const response = await request(httpServer)
    .post('/api/v1/rooms/create')
    .expect(201);

  return response.body as CreateRoomResponse;
}

export async function joinRoom(
  httpServer: Server,
  roomCode: string,
  username: string,
): Promise<JoinRoomResponse> {
  const response = await request(httpServer)
    .post('/api/v1/rooms/join')
    .send({ roomCode, username })
    .expect(200);

  return response.body as JoinRoomResponse;
}

export function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/game`;
}

export function connectSocket(
  port: number,
  token: string,
  timeoutMs = 8000,
): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket: ClientSocket = io(wsUrl(port), {
      transports: ['websocket'],
      forceNew: true,
      query: { token },
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connection timed out'));
    }, timeoutMs);

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

export function waitForEvent<T>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 10000,
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

export function emitAck<T>(
  socket: ClientSocket,
  event: string,
  payload: unknown,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ack on ${event}`));
    }, timeoutMs);

    socket.emit(event, payload, (response: T) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(intervalMs);
  }

  throw new Error('waitUntil predicate never became true');
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function strokeKey(
  roomCode: string,
  round: number,
  playerId: string,
): string {
  return `sti:v1:room:${roomCode}:round:${round}:player:${playerId}`;
}

export async function setupTwoPlayerRoom(ctx: E2EContext): Promise<{
  roomCode: string;
  hostSocket: ClientSocket;
  guestSocket: ClientSocket;
  hostId: string;
  guestId: string;
}> {
  const createBody = await createRoom(ctx.httpServer);
  const joinBody = await joinRoom(ctx.httpServer, createBody.roomCode, 'Guest');

  const hostSocket = await connectSocket(
    ctx.serverPort,
    createBody.reconnectToken,
  );
  const guestSocket = await connectSocket(
    ctx.serverPort,
    joinBody.reconnectToken,
  );

  return {
    roomCode: createBody.roomCode,
    hostSocket,
    guestSocket,
    hostId: createBody.hostId,
    guestId: joinBody.playerId,
  };
}

export async function startDrawingPhase(
  hostSocket: ClientSocket,
  guestSocket: ClientSocket,
): Promise<void> {
  hostSocket.emit('v1:host:update_settings', {
    timerDuration: 60,
    totalRounds: 1,
    theme: 'RANDOM',
  });
  hostSocket.emit('v1:host:start_game');
  await waitForEvent(hostSocket, 'v1:game:round_started');

  await emitAck(guestSocket, 'v1:canvas:submit_drawing', {
    strokes: MINIMAL_STROKES,
  });
  await emitAck(hostSocket, 'v1:canvas:submit_drawing', {
    strokes: MINIMAL_STROKES,
  });

  await delay(300);
  await waitForEvent(hostSocket, 'v1:gallery:next_canvas', 15000);
}

export async function completeGalleryVoting(
  hostSocket: ClientSocket,
  guestSocket: ClientSocket,
  canvases: number,
): Promise<void> {
  for (let canvas = 0; canvas < canvases; canvas++) {
    guestSocket.emit('v1:vote:cast_stars', { stars: 7 });
    hostSocket.emit('v1:vote:cast_stars', { stars: 9 });

    if (canvas < canvases - 1) {
      await delay(1000);
    }
  }
}

export function waitForSocketFailure(
  socket: ClientSocket,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Expected socket rejection did not occur'));
    }, timeoutMs);

    const finish = (): void => {
      clearTimeout(timer);
      socket.disconnect();
      resolve();
    };

    socket.on('connect_error', finish);
    socket.on('disconnect', finish);
    socket.on('error:exception', finish);
  });
}

export function disconnectAll(...sockets: ClientSocket[]): void {
  for (const socket of sockets) {
    if (socket.connected) {
      socket.disconnect();
    }
  }
}
