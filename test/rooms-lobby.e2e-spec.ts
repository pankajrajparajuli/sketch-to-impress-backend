import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
// ... rest of your imports
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_KEYS } from '../src/redis/redis.keys';
import { AddressInfo } from 'net';
import { Server } from 'http';

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

describe('Room & Lobby Handshake Pipeline (E2E)', () => {
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

    // Dynamic port assignment to avoid collision during parallel runs
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

  // ─── CASE 10: FULL PIPELINE HANDOFF ───────────────────────────────────────
  it('should create room via HTTP and finalize socket registry inside Redis', async () => {
    const createRes = await request(httpServer)
      .post('/api/v1/rooms/create')
      .expect(201);

    const body = createRes.body as CreateRoomResponse;
    expect(body.success).toBe(true);
    const { roomCode, reconnectToken, hostId } = body;

    const wsUrl = `ws://127.0.0.1:${serverPort}/game`;
    const clientSocket: ClientSocket = io(wsUrl, {
      transports: ['websocket'],
      forceNew: true,
      query: { token: reconnectToken },
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clientSocket.disconnect();
        reject(new Error('WebSocket handoff timed out!'));
      }, 3000);

      clientSocket.on('connect', () => {
        clearTimeout(timeout);

        redisService
          .getClient()
          .smembers(REDIS_KEYS.ROOM_PLAYERS(roomCode))
          .then((players) => {
            expect(players).toContain(hostId);
            clientSocket.disconnect();
            resolve();
          })
          .catch((err: unknown) => {
            clientSocket.disconnect();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });

      clientSocket.on('connect_error', (err: Error) => {
        clearTimeout(timeout);
        clientSocket.disconnect();
        reject(err);
      });
    });
  });

  // ─── CASE 11: TOKEN GUARD REJECTION ───────────────────────────────────────
  it('should refuse real-time connections that supply an invalid token payload', async () => {
    const wsUrl = `ws://127.0.0.1:${serverPort}/game`;
    const clientSocket: ClientSocket = io(wsUrl, {
      transports: ['websocket'],
      forceNew: true,
      query: { token: 'BAD_GARBAGE_TOKEN_VALUE' },
    });

    await new Promise<void>((resolve) => {
      clientSocket.on('connect_error', () => {
        expect(clientSocket.connected).toBe(false);
        clientSocket.disconnect();
        resolve();
      });
    });
  });

  // ─── CASE 12: UNKNOWN ROOM HANDSHAKE REJECTION ────────────────────────────
  it('should disconnect connection if the token references an expired or missing room', async () => {
    const fakeRes = await request(httpServer)
      .post('/api/v1/rooms/create')
      .expect(201);

    const body = fakeRes.body as CreateRoomResponse;
    const { reconnectToken } = body;

    await redisService.getClient().flushdb();

    const wsUrl = `ws://127.0.0.1:${serverPort}/game`;
    const clientSocket: ClientSocket = io(wsUrl, {
      transports: ['websocket'],
      forceNew: true,
      query: { token: reconnectToken },
    });

    await new Promise<void>((resolve) => {
      clientSocket.on('disconnect', () => {
        expect(clientSocket.connected).toBe(false);
        clientSocket.disconnect();
        resolve();
      });
    });
  });

  // ─── CASE 13: ROSTER BROADCAST SYNC ────────────────────────────────────────
  it('should dispatch room roster broadcast updates when new players connect', async () => {
    const hostRes = await request(httpServer)
      .post('/api/v1/rooms/create')
      .expect(201);
    const hostBody = hostRes.body as CreateRoomResponse;
    const { roomCode, reconnectToken: hostToken } = hostBody;

    const guestRes = await request(httpServer)
      .post('/api/v1/rooms/join')
      .send({ roomCode, username: 'PixelPainter' })
      .expect(200);
    const guestBody = guestRes.body as JoinRoomResponse;
    const { reconnectToken: guestToken } = guestBody;

    const wsUrl = `ws://127.0.0.1:${serverPort}/game`;

    const hostSocket: ClientSocket = io(wsUrl, {
      transports: ['websocket'],
      query: { token: hostToken },
    });

    await new Promise<void>((resolve) => {
      hostSocket.on('connect', () => {
        const guestSocket: ClientSocket = io(wsUrl, {
          transports: ['websocket'],
          query: { token: guestToken },
        });

        hostSocket.on('v1:room:roster_updated', (roster: unknown) => {
          expect(roster).toBeDefined();
          guestSocket.disconnect();
          hostSocket.disconnect();
          resolve();
        });
      });
    });
  });

  // ─── CASE 14: RESERVATION FLUSHING ────────────────────────────────────────
  it('should purge short-term reservation keys immediately upon successful connection', async () => {
    const createRes = await request(httpServer)
      .post('/api/v1/rooms/create')
      .expect(201);
    const body = createRes.body as CreateRoomResponse;
    const { roomCode, reconnectToken, hostId } = body;

    const reservationKey = REDIS_KEYS.RESERVATION(roomCode, hostId);

    const preCheck = await redisService.getClient().exists(reservationKey);
    expect(preCheck).toBe(1);

    const wsUrl = `ws://127.0.0.1:${serverPort}/game`;
    const clientSocket: ClientSocket = io(wsUrl, {
      transports: ['websocket'],
      query: { token: reconnectToken },
    });

    await new Promise<void>((resolve, reject) => {
      clientSocket.on('connect', () => {
        redisService
          .getClient()
          .exists(reservationKey)
          .then((postCheck) => {
            expect(postCheck).toBe(0);
            clientSocket.disconnect();
            resolve();
          })
          .catch((err: unknown) => {
            clientSocket.disconnect();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    });
  });
});
