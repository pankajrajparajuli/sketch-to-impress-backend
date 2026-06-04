import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomStatus } from '../rooms/enums/room-status.enum';
import {
  V1ReconnectState,
  RosterPlayer,
  LeaderboardEntry,
} from './interfaces/v1-reconnect-state.interface';

// ─── Decoded JWT shape ─────────────────────────────────────────────────────────
interface JwtPayload {
  playerId: string;
  roomCode: string;
  isHost: boolean;
}

// ─── Custom Socket Data Type ──────────────────────────────────────────────────
interface CustomSocketData {
  playerId: string;
  roomCode: string;
  username: string;
  isHost: boolean;
}

// Explicit type for our application sockets
type AppSocket = Socket<any, any, any, CustomSocketData>;

@WebSocketGateway({
  namespace: '/game',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
})
export class GameGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);

  constructor(private readonly redis: RedisService) {}

  afterInit(): void {
    this.logger.log(
      JSON.stringify({
        event: 'gateway_init',
        message: 'GameGateway WebSocket server initialized.',
        namespace: '/game',
      }),
    );
  }

  // ── Client Connection ─────────────────────────────────────────────────────────

  async handleConnection(client: AppSocket): Promise<void> {
    try {
      // Safely extract from handshake structures typed as 'any'
      const auth = client.handshake.auth as Record<string, unknown> | undefined;
      const headers = client.handshake.headers as
        | Record<string, string | undefined>
        | undefined;

      const token =
        (auth?.token as string | undefined) ??
        headers?.authorization?.replace('Bearer ', '') ??
        (client.handshake.query?.token as string | undefined); // Added query fallback for Postman testing

      if (!token) {
        this.rejectClient(
          client,
          'MISSING_TOKEN',
          'No reconnect token provided.',
        );
        return;
      }

      // ── Verify and decode JWT ──────────────────────────────────────────────
      let payload: JwtPayload;
      try {
        payload = jwt.verify(
          token,
          process.env.JWT_SECRET ?? 'dev_secret',
        ) as unknown as JwtPayload;
      } catch {
        this.rejectClient(
          client,
          'INVALID_TOKEN',
          'Token is invalid or expired.',
        );
        return;
      }

      const { playerId, roomCode, isHost } = payload;

      // ── Validate room exists ───────────────────────────────────────────────
      const metaKey = REDIS_KEYS.ROOM_META(roomCode);
      const roomExists = await this.redis.exists(metaKey);
      if (!roomExists) {
        this.rejectClient(
          client,
          'ROOM_NOT_FOUND',
          `Room ${roomCode} not found.`,
        );
        return;
      }

      // ── Fetch current room state ───────────────────────────────────────────
      const stateKey = REDIS_KEYS.ROOM_STATE(roomCode);
      const roomState = await this.redis.hgetall(stateKey);
      const phase = (roomState.status as RoomStatus) ?? RoomStatus.LOBBY;
      const currentRound = parseInt(roomState.currentRound ?? '1', 10);

      // ── Check if this is a reconnection (player already in roster) ─────────
      const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);
      const existingPlayerRaw = await this.redis.hget(playersKey, playerId);
      const isReconnecting = existingPlayerRaw !== null;

      // ── Fetch username ─────────────────────────────────────────────────────
      let username = 'Unknown';
      if (isReconnecting && existingPlayerRaw) {
        const existing = JSON.parse(existingPlayerRaw) as RosterPlayer;
        username = existing.username;
      } else {
        const reservationKey = REDIS_KEYS.RESERVATION(roomCode, playerId);
        const reservationRaw = await this.redis.get(reservationKey);
        if (reservationRaw) {
          const reservation = JSON.parse(reservationRaw) as {
            username: string;
          };
          username = reservation.username;
          await this.redis.del(reservationKey);
        }
      }

      // ── Bind verified identity onto socket.data ────────────────────────────
      client.data.playerId = playerId;
      client.data.roomCode = roomCode;
      client.data.username = username;
      client.data.isHost = isHost;

      // ── Join the Socket.io room channel ────────────────────────────────────
      await client.join(roomCode);

      // ── Update player presence in Redis ───────────────────────────────────
      await this.redis.savePlayerPresence(roomCode, {
        playerId,
        username,
        isHost,
        connected: true,
      });

      // Legacy fallback storage to retain dynamic roster updates until completely migrated
      await this.redis.hset(
        playersKey,
        playerId,
        JSON.stringify({
          playerId,
          username,
          isHost,
          connected: true,
        }),
      );

      await this.redis.touchRoom(roomCode, currentRound);

      this.logger.log(
        JSON.stringify({
          event: isReconnecting ? 'player_reconnected' : 'player_connected',
          playerId,
          roomCode,
          socketId: client.id,
          phase,
        }),
      );

      if (isReconnecting) {
        const snapshot = await this.buildReconnectSnapshot(
          client,
          roomCode,
          playerId,
          phase,
          roomState,
          currentRound,
        );
        client.emit('v1:player:reconnected', snapshot);
      } else {
        const roster = await this.getRoster(roomCode);
        this.server
          .to(roomCode)
          .emit('v1:room:roster_updated', { players: roster });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection error.';
      this.rejectClient(client, 'CONNECTION_ERROR', message);
    }
  }

  // ── Client Disconnect ─────────────────────────────────────────────────────────

  async handleDisconnect(client: AppSocket): Promise<void> {
    const { playerId, roomCode } = client.data;

    if (!playerId || !roomCode) return;

    try {
      const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);
      const playerRaw = await this.redis.hget(playersKey, playerId);

      if (playerRaw) {
        const player = JSON.parse(playerRaw) as RosterPlayer;

        await this.redis.hset(
          playersKey,
          playerId,
          JSON.stringify({ ...player, connected: false }),
        );
      }

      this.logger.log(
        JSON.stringify({
          event: 'player_disconnected',
          playerId,
          roomCode,
          socketId: client.id,
        }),
      );

      const roster = await this.getRoster(roomCode);
      this.server
        .to(roomCode)
        .emit('v1:room:roster_updated', { players: roster });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Disconnect error.';
      this.logger.error(
        JSON.stringify({
          event: 'disconnect_error',
          playerId,
          roomCode,
          message,
        }),
      );
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────────────

  private rejectClient(client: AppSocket, code: string, message: string): void {
    this.logger.warn(
      JSON.stringify({
        event: 'connection_rejected',
        code,
        message,
        socketId: client.id,
      }),
    );
    client.emit('error:exception', { success: false, code, message });
    client.disconnect(true);
  }

  async getRoster(roomCode: string): Promise<RosterPlayer[]> {
    const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);
    const all = await this.redis.hgetall(playersKey);
    return Object.values(all).map((raw) => JSON.parse(raw) as RosterPlayer);
  }

  private async buildReconnectSnapshot(
    client: AppSocket,
    roomCode: string,
    playerId: string,
    phase: RoomStatus,
    roomState: Record<string, string>,
    currentRound: number,
  ): Promise<V1ReconnectState> {
    const leaderboardKey = REDIS_KEYS.LEADERBOARD(roomCode);
    const leaderboardRaw = await this.redis.hgetall(leaderboardKey);

    const roster = await this.getRoster(roomCode);

    const leaderboard: LeaderboardEntry[] = roster.map((p) => ({
      playerId: p.playerId,
      username: p.username,
      stars: parseInt(leaderboardRaw[p.playerId] ?? '0', 10),
    }));

    const roundEndTimestamp = parseInt(roomState.roundEndTimestamp ?? '0', 10);
    const remainingTime =
      roundEndTimestamp > 0
        ? Math.max(0, Math.ceil((roundEndTimestamp - Date.now()) / 1000))
        : 0;

    return {
      roomCode,
      playerId,
      phase,
      currentRound,
      totalRounds: parseInt(roomState.totalRounds ?? '3', 10),
      timerDuration: parseInt(roomState.timerDuration ?? '90', 10),
      theme: roomState.theme ?? 'Cartoon',
      remainingTime,
      activePrompt: roomState.activePrompt ?? null,
      leaderboard,
      players: roster,
    };
  }
}
