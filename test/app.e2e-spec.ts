import 'reflect-metadata';
import * as request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_KEYS } from '../src/redis/redis.keys';
import { RoomStatus } from '../src/rooms/enums/room-status.enum';
import { V1ReconnectState } from '../src/game/interfaces/v1-reconnect-state.interface';
import { GameGateway } from '../src/game/game.gateway';
import { GameService } from '../src/game/game.service';
import {
  ALT_STROKES,
  bootstrapE2EApp,
  completeGalleryVoting,
  connectSocket,
  createRoom,
  delay,
  disconnectAll,
  emitAck,
  E2EContext,
  joinRoom,
  MINIMAL_STROKES,
  setupTwoPlayerRoom,
  startDrawingPhase,
  strokeKey,
  teardownE2EApp,
  waitForEvent,
  waitForSocketFailure,
  waitUntil,
  wsUrl,
} from './helpers/e2e.helpers';

jest.setTimeout(45000);

describe('STI Backend E2E Integration Suite (Sprint 30)', () => {
  let ctx: E2EContext;
  let redisService: RedisService;

  beforeAll(async () => {
    ctx = await bootstrapE2EApp();
    redisService = ctx.redisService;
  });

  beforeEach(async () => {
    await redisService.getClient().flushdb();
  });

  afterEach(async () => {
    const gateway = ctx.app.get(GameGateway);
    gateway.clearAllGalleryTimersForTest();
    gateway.clearAllHostMigrationTimersForTest();
    ctx.app.get(GameService).clearAllPhaseTimersForTest();
    await delay(100);
  });

  afterAll(async () => {
    await teardownE2EApp(ctx);
  });

  // ─── Infrastructure ────────────────────────────────────────────────────────

  describe('Infrastructure & volatile memory contract', () => {
    it('GET /health returns ok', async () => {
      await request(ctx.httpServer)
        .get('/health')
        .expect(200)
        .expect({ status: 'ok' });
    });

    it('requires username (max 15) to create and join a lobby', async () => {
      await request(ctx.httpServer)
        .post('/api/v1/rooms/create')
        .send({})
        .expect(400);

      await request(ctx.httpServer)
        .post('/api/v1/rooms/create')
        .send({ username: 'a'.repeat(16) })
        .expect(400);

      const room = await createRoom(ctx.httpServer, 'HostName');
      expect(room.playerId).toBe(room.hostId);
      expect(room.username).toBe('HostName');

      await request(ctx.httpServer)
        .post('/api/v1/rooms/join')
        .send({ roomCode: room.roomCode })
        .expect(400);

      const guest = await joinRoom(ctx.httpServer, room.roomCode, 'Guest');
      expect(guest.playerId).toBeDefined();
      expect(guest.username).toBe('Guest');
      expect(guest.hostId).toBe(room.hostId);
    });

    it('stores all session keys under the versioned sti:v1 prefix only', async () => {
      const room = await createRoom(ctx.httpServer);
      await joinRoom(ctx.httpServer, room.roomCode, 'Guest');

      const keys = await redisService.getClient().keys('sti:v1:*');
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => key.startsWith('sti:v1:'))).toBe(true);
      expect(keys.some((key) => key.includes(':meta'))).toBe(true);
      expect(keys.some((key) => key.includes(':state'))).toBe(true);
    });
  });

  // ─── Multi-client handshakes ─────────────────────────────────────────────────

  describe('Multi-client connection handshakes', () => {
    it('registers host and multiple guests in Redis after websocket connect', async () => {
      const room = await createRoom(ctx.httpServer);
      const guestA = await joinRoom(ctx.httpServer, room.roomCode, 'GuestA');
      const guestB = await joinRoom(ctx.httpServer, room.roomCode, 'GuestB');

      const hostSocket = await connectSocket(
        ctx.serverPort,
        room.reconnectToken,
      );
      const guestASocket = await connectSocket(
        ctx.serverPort,
        guestA.reconnectToken,
      );
      const guestBSocket = await connectSocket(
        ctx.serverPort,
        guestB.reconnectToken,
      );

      await waitUntil(async () => {
        const roster = await redisService
          .getClient()
          .smembers(REDIS_KEYS.ROOM_PLAYERS(room.roomCode));
        return roster.length === 3;
      });

      const roster = await redisService
        .getClient()
        .smembers(REDIS_KEYS.ROOM_PLAYERS(room.roomCode));

      expect(roster).toContain(room.hostId);
      expect(roster).toContain(guestA.playerId);
      expect(roster).toContain(guestB.playerId);

      disconnectAll(hostSocket, guestASocket, guestBSocket);
    });

    it('rejects invalid tokens and unknown rooms at the socket edge', async () => {
      const badSocket: ClientSocket = io(wsUrl(ctx.serverPort), {
        transports: ['websocket'],
        forceNew: true,
        query: { token: 'INVALID_TOKEN' },
      });

      await waitForSocketFailure(badSocket);

      const room = await createRoom(ctx.httpServer);
      const staleToken = room.reconnectToken;
      await redisService.getClient().flushdb();

      const staleSocket: ClientSocket = io(wsUrl(ctx.serverPort), {
        transports: ['websocket'],
        forceNew: true,
        query: { token: staleToken },
      });

      await waitForSocketFailure(staleSocket);
    });

    it('flushes reservation keys once a player completes websocket handoff', async () => {
      const room = await createRoom(ctx.httpServer);
      const reservationKey = REDIS_KEYS.RESERVATION(room.roomCode, room.hostId);

      expect(await redisService.getClient().exists(reservationKey)).toBe(1);

      const hostSocket = await connectSocket(
        ctx.serverPort,
        room.reconnectToken,
      );

      await waitUntil(async () => {
        return (await redisService.getClient().exists(reservationKey)) === 0;
      });

      hostSocket.disconnect();
    });

    it('broadcasts roster updates when additional players join live sockets', async () => {
      const room = await createRoom(ctx.httpServer);
      const guest = await joinRoom(ctx.httpServer, room.roomCode, 'Painter');

      const hostSocket = await connectSocket(
        ctx.serverPort,
        room.reconnectToken,
      );

      const playerJoined = waitForEvent(hostSocket, 'v1:room:player_joined');
      const guestSocket = await connectSocket(
        ctx.serverPort,
        guest.reconnectToken,
      );

      await playerJoined;
      guestSocket.disconnect();
      hostSocket.disconnect();
    });
  });

  // ─── SETNX concurrency hardening ─────────────────────────────────────────────

  describe('SETNX lock concurrency hardening', () => {
    it('allows only one match initialization when start_game fires concurrently', async () => {
      const { roomCode, hostSocket, guestSocket } = await setupTwoPlayerRoom(ctx);

      let roundStartedCount = 0;
      hostSocket.on('v1:game:round_started', () => {
        roundStartedCount++;
      });

      hostSocket.emit('v1:host:start_game');
      hostSocket.emit('v1:host:start_game');
      hostSocket.emit('v1:host:start_game');

      await delay(400);

      const roomState = await redisService
        .getClient()
        .hgetall(REDIS_KEYS.ROOM_STATE(roomCode));

      expect(roomState.status).toBe(RoomStatus.DRAWING);
      expect(roundStartedCount).toBe(1);

      disconnectAll(hostSocket, guestSocket);
    });

    it('blocks duplicate star votes on the same canvas via voter SETNX semantics', async () => {
      const { hostSocket, guestSocket } = await setupTwoPlayerRoom(ctx);
      await startDrawingPhase(hostSocket, guestSocket);

      let voterSocket = guestSocket;
      let firstVote = await emitAck<{ success: boolean }>(
        guestSocket,
        'v1:vote:cast_stars',
        { stars: 8 },
      );

      if (!firstVote.success) {
        voterSocket = hostSocket;
        firstVote = await emitAck<{ success: boolean }>(
          hostSocket,
          'v1:vote:cast_stars',
          { stars: 8 },
        );
      }

      const duplicateVote = await emitAck<{ success: boolean }>(
        voterSocket,
        'v1:vote:cast_stars',
        { stars: 8 },
      );

      expect(firstVote.success).toBe(true);
      expect(duplicateVote.success).toBe(false);

      disconnectAll(hostSocket, guestSocket);
    });

    it('blocks duplicate drawing submissions and preserves original vector payload', async () => {
      const { roomCode, hostSocket, guestSocket, hostId } =
        await setupTwoPlayerRoom(ctx);

      hostSocket.emit('v1:host:update_settings', {
        timerDuration: 60,
        totalRounds: 1,
        theme: 'RANDOM',
      });
      hostSocket.emit('v1:host:start_game');
      await waitForEvent(hostSocket, 'v1:game:round_started');

      const firstSubmit = await emitAck<{
        success: boolean;
        strokeCount: number;
      }>(hostSocket, 'v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });

      const duplicateSubmit = await emitAck<{
        success: boolean;
        strokeCount: number;
      }>(hostSocket, 'v1:canvas:submit_drawing', { strokes: ALT_STROKES });

      expect(firstSubmit.success).toBe(true);
      expect(firstSubmit.strokeCount).toBe(1);
      expect(duplicateSubmit.success).toBe(false);
      expect(duplicateSubmit.strokeCount).toBe(0);

      const storedRaw = await redisService
        .getClient()
        .get(strokeKey(roomCode, 1, hostId));
      expect(storedRaw).toBe(JSON.stringify(MINIMAL_STROKES));
      expect(storedRaw).not.toBe(JSON.stringify(ALT_STROKES));

      guestSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });
      disconnectAll(hostSocket, guestSocket);
    });

    it('prevents concurrent duplicate submissions from racing into gallery twice', async () => {
      const { hostSocket, guestSocket } = await setupTwoPlayerRoom(ctx);

      let phaseChangedCount = 0;
      hostSocket.on('v1:game:phase_changed', (payload: { status: string }) => {
        if (payload.status === RoomStatus.GALLERY) {
          phaseChangedCount++;
        }
      });

      hostSocket.emit('v1:host:update_settings', {
        timerDuration: 60,
        totalRounds: 1,
        theme: 'RANDOM',
      });
      hostSocket.emit('v1:host:start_game');
      await waitForEvent(hostSocket, 'v1:game:round_started');

      await Promise.all([
        emitAck(guestSocket, 'v1:canvas:submit_drawing', {
          strokes: MINIMAL_STROKES,
        }),
        emitAck(hostSocket, 'v1:canvas:submit_drawing', {
          strokes: MINIMAL_STROKES,
        }),
        emitAck(guestSocket, 'v1:canvas:submit_drawing', {
          strokes: ALT_STROKES,
        }),
      ]);

      await waitForEvent(hostSocket, 'v1:gallery:next_canvas', 15000);
      await delay(200);

      expect(phaseChangedCount).toBe(1);

      disconnectAll(hostSocket, guestSocket);
    });
  });

  // ─── Disconnect, reconnect, host migration ─────────────────────────────────

  describe('Disconnection routines and recovery snapshots', () => {
    it('delivers an accurate reconnect snapshot with synchronized server clocks', async () => {
      const room = await createRoom(ctx.httpServer);
      const guest = await joinRoom(ctx.httpServer, room.roomCode, 'Guest');

      const hostSocket = await connectSocket(
        ctx.serverPort,
        room.reconnectToken,
      );
      const guestSocket = await connectSocket(
        ctx.serverPort,
        guest.reconnectToken,
      );

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

      guestSocket.disconnect();
      await delay(200);

      const reconnected = await connectSocket(
        ctx.serverPort,
        guest.reconnectToken,
      );

      const snapshot = await waitForEvent<V1ReconnectState>(
        reconnected,
        'v1:player:reconnected',
      );

      expect(snapshot.phase).toBe(RoomStatus.DRAWING);
      expect(snapshot.currentRound).toBe(1);
      expect(snapshot.roundEndTimestamp).toBe(roundStarted.roundEndTimestamp);
      expect(snapshot.remainingSeconds).toBeGreaterThan(0);
      expect(snapshot.serverTime).toBeLessThanOrEqual(Date.now());
      expect(snapshot.players.some((p) => p.playerId === guest.playerId)).toBe(
        true,
      );

      disconnectAll(hostSocket, reconnected);
    });

    it('migrates host authority when the host fails to reconnect within grace window', async () => {
      const room = await createRoom(ctx.httpServer);
      const guest = await joinRoom(ctx.httpServer, room.roomCode, 'Survivor');

      const hostSocket = await connectSocket(
        ctx.serverPort,
        room.reconnectToken,
      );
      const guestSocket = await connectSocket(
        ctx.serverPort,
        guest.reconnectToken,
      );

      hostSocket.emit('v1:host:update_settings', {
        timerDuration: 60,
        totalRounds: 1,
        theme: 'RANDOM',
      });
      hostSocket.emit('v1:host:start_game');
      await waitForEvent(hostSocket, 'v1:game:round_started');

      hostSocket.disconnect();

      await waitUntil(async () => {
        const reconnectActive = await redisService
          .getClient()
          .exists(REDIS_KEYS.PLAYER_RECONNECT(room.hostId));
        return reconnectActive === 0;
      }, 5000);

      await delay(Number(process.env.HOST_MIGRATION_GRACE_MS ?? 2000) + 200);

      const hostFlag = await redisService.hgetall(
        REDIS_KEYS.PLAYER_HASH(guest.playerId),
      );
      expect(hostFlag.isHost).toBe('true');
      expect(hostFlag.username).toBe('Survivor');

      guestSocket.disconnect();
    });

    it('recalculates gallery completion after mid-voting disconnect', async () => {
      const room = await createRoom(ctx.httpServer);
      const guestOne = await joinRoom(ctx.httpServer, room.roomCode, 'GuestOne');
      const guestTwo = await joinRoom(ctx.httpServer, room.roomCode, 'GuestTwo');

      const hostSocket = await connectSocket(
        ctx.serverPort,
        room.reconnectToken,
      );
      const guestOneSocket = await connectSocket(
        ctx.serverPort,
        guestOne.reconnectToken,
      );
      const guestTwoSocket = await connectSocket(
        ctx.serverPort,
        guestTwo.reconnectToken,
      );

      hostSocket.emit('v1:host:update_settings', {
        timerDuration: 60,
        totalRounds: 1,
        theme: 'RANDOM',
      });
      hostSocket.emit('v1:host:start_game');
      await waitForEvent(hostSocket, 'v1:game:round_started');

      hostSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });
      guestOneSocket.emit('v1:canvas:submit_drawing', {
        strokes: MINIMAL_STROKES,
      });
      guestTwoSocket.emit('v1:canvas:submit_drawing', {
        strokes: MINIMAL_STROKES,
      });

      await waitForEvent(hostSocket, 'v1:gallery:next_canvas', 15000);

      hostSocket.emit('v1:vote:cast_stars', { stars: 5 });
      guestOneSocket.emit('v1:vote:cast_stars', { stars: 6 });
      await delay(250);
      guestTwoSocket.disconnect();

      await waitForEvent(hostSocket, 'v1:gallery:next_canvas', 15000);

      disconnectAll(hostSocket, guestOneSocket);
    });
  });

  // ─── Game pipeline & vector eviction ───────────────────────────────────────

  describe('Game pipeline, scoring, and vector eviction', () => {
    it('ships authoritative timestamps on round start and gallery canvases', async () => {
      const { hostSocket, guestSocket } = await setupTwoPlayerRoom(ctx);

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

      expect(roundStarted.roundEndTimestamp).toBeGreaterThan(
        roundStarted.serverTime,
      );

      hostSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });
      guestSocket.emit('v1:canvas:submit_drawing', { strokes: MINIMAL_STROKES });

      const nextCanvas = await waitForEvent<{
        galleryEndTimestamp: number;
        serverTime: number;
      }>(hostSocket, 'v1:gallery:next_canvas', 15000);

      expect(nextCanvas.galleryEndTimestamp).toBeGreaterThan(
        nextCanvas.serverTime,
      );

      disconnectAll(hostSocket, guestSocket);
    });

    it('aggregates scores and advances gallery when active voters finish', async () => {
      const { hostSocket, guestSocket } = await setupTwoPlayerRoom(ctx);
      await startDrawingPhase(hostSocket, guestSocket);

      const roundCompletePromise = waitForEvent<{
        standings: Array<{ score: number; rank: number }>;
      }>(hostSocket, 'v1:game:round_complete', 20000);

      await completeGalleryVoting(hostSocket, guestSocket, 2);

      const roundComplete = await roundCompletePromise;
      expect(roundComplete.standings.some((entry) => entry.score > 0)).toBe(
        true,
      );

      disconnectAll(hostSocket, guestSocket);
    });

    it('evicts round stroke vectors from volatile memory after gallery completes', async () => {
      const { roomCode, hostSocket, guestSocket, hostId, guestId } =
        await setupTwoPlayerRoom(ctx);

      await startDrawingPhase(hostSocket, guestSocket);

      const hostStrokeKey = strokeKey(roomCode, 1, hostId);
      const guestStrokeKey = strokeKey(roomCode, 1, guestId);

      expect(await redisService.getClient().exists(hostStrokeKey)).toBe(1);
      expect(await redisService.getClient().exists(guestStrokeKey)).toBe(1);

      const roundCompletePromise = waitForEvent(
        hostSocket,
        'v1:game:round_complete',
        25000,
      );
      await completeGalleryVoting(hostSocket, guestSocket, 2);
      await roundCompletePromise;
      await delay(300);

      expect(await redisService.getClient().exists(hostStrokeKey)).toBe(0);
      expect(await redisService.getClient().exists(guestStrokeKey)).toBe(0);

      disconnectAll(hostSocket, guestSocket);
    });

    it('publishes match standings and resets lobby on play again', async () => {
      const { roomCode, hostSocket, guestSocket } = await setupTwoPlayerRoom(ctx);

      await startDrawingPhase(hostSocket, guestSocket);

      const roundCompletePromise = waitForEvent(
        hostSocket,
        'v1:game:round_complete',
        25000,
      );
      await completeGalleryVoting(hostSocket, guestSocket, 2);
      await roundCompletePromise;

      hostSocket.emit('v1:debug:advance_phase');
      await waitForEvent(hostSocket, 'v1:game:phase_changed', 10000);
      hostSocket.emit('v1:debug:advance_phase');

      const matchOver = await waitForEvent<{
        podium: Array<{ rank: number }>;
        standings: unknown[];
      }>(hostSocket, 'v1:game:match_over', 10000);

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

      disconnectAll(hostSocket, guestSocket);
    });
  });
});
