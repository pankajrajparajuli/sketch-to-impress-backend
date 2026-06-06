import { Logger, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import * as jwt from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';

import { GatewayGuard } from '../common/guards/gateway.guard';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomStatus } from '../rooms/enums/room-status.enum';
import { GameService } from './game.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

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

type AppSocket = Socket<any, any, any, CustomSocketData>;

@WebSocketGateway({
  namespace: '/game',
  cors: {
    // Splits multiple URLs if provided in .env, otherwise defaults to '*' for easy testing
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(',')
      : '*',
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

  constructor(
    private readonly redis: RedisService,
    private readonly gameService: GameService,
  ) {}

  afterInit(): void {
    this.logger.log(
      JSON.stringify({
        event: 'gateway_init',
        message: 'GameGateway WebSocket server initialized.',
        namespace: '/game',
      }),
    );
  }

  // ── WebSocket Ingestion Pipeline Event Listeners ─────────────────────────────

  /**
   * Intercepts host parameter modifications, persists changes to the volatile Redis cache layer,
   * and broadcasts the fresh configuration matrices to all active session participants.
   */
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @UseGuards(GatewayGuard)
  @SubscribeMessage('v1:host:update_settings')
  async updateSettings(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() dto: UpdateSettingsDto,
  ): Promise<void> {
    const { roomCode } = client.data;

    // 1. Commit changes to Redis via the central game engine service layer
    await this.gameService.updateRoomSettings(roomCode, dto);

    // 2. Broadcast structural state sync event to all clients in the channel room
    this.server.to(roomCode).emit('v1:room:settings_changed', dto);
    this.server.to(roomCode).emit('v1:room:settings_updated', dto);
  }

  // ── Client Connection ─────────────────────────────────────────────────────────

  async handleConnection(client: AppSocket): Promise<void> {
    try {
      const auth = client.handshake.auth as Record<string, unknown> | undefined;
      const headers = client.handshake.headers as
        | Record<string, string | undefined>
        | undefined;

      const token =
        (auth?.token as string | undefined) ??
        headers?.authorization?.replace('Bearer ', '') ??
        (client.handshake.query?.token as string | undefined);

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

      // ── Bind tracking properties onto context data object layer ───────────
      client.data.playerId = playerId;
      client.data.roomCode = roomCode;
      client.data.isHost = isHost;

      // ── Active Reconnection Logic Implementation ──────────────────────────
      const canReconnect = await this.gameService.canReconnect(playerId);

      if (canReconnect) {
        // 1. Recover standard data fields directly from the primary player state block
        const playerHashKey = REDIS_KEYS.PLAYER_HASH(playerId);
        const existingPlayerRaw = await this.redis.hgetall(playerHashKey);
        client.data.username = existingPlayerRaw.username ?? 'Unknown';

        // 2. Re-establish server memory mappings and sync pipeline states
        await this.gameService.markPlayerConnected(playerId);
        await client.join(roomCode);

        // 3. Compile context matrices and deliver back down to client interface
        const snapshot = await this.gameService.buildReconnectSnapshot(
          roomCode,
          playerId,
        );
        client.emit('v1:player:reconnected', snapshot);

        this.logger.log(
          JSON.stringify({
            event: 'player_reconnected',
            playerId,
            roomCode,
            socketId: client.id,
            phase: snapshot.phase,
          }),
        );
      } else {
        // ── Fresh Connection Flow Process ───────────────────────────────────
        const reservationKey = REDIS_KEYS.RESERVATION(roomCode, playerId);
        const reservationRaw = await this.redis.get(reservationKey);
        let username = 'Unknown';

        if (reservationRaw) {
          const reservation = JSON.parse(reservationRaw) as {
            username: string;
          };
          username = reservation.username;
          await this.redis.del(reservationKey);
        }

        client.data.username = username;

        // Save entry allocations to storage cache layers
        await this.gameService.addPlayerToRoster(
          roomCode,
          playerId,
          username,
          isHost,
        );
        await client.join(roomCode);

        const stateKey = REDIS_KEYS.ROOM_STATE(roomCode);
        const roomState = await this.redis.hgetall(stateKey);
        const currentRound = parseInt(roomState.currentRound ?? '1', 10);
        await this.redis.touchRoom(roomCode, currentRound);

        const roster = await this.gameService.getRoomRoster(roomCode);
        this.server.to(roomCode).emit('v1:room:player_joined', {
          roomCode,
          players: roster,
        });

        this.logger.log(
          JSON.stringify({
            event: 'player_connected',
            playerId,
            roomCode,
            socketId: client.id,
            phase: roomState.status ?? RoomStatus.LOBBY,
          }),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection error.';
      this.rejectClient(client, 'CONNECTION_ERROR', message);
    }
  }

  // ── Client Disconnect ─────────────────────────────────────────────────────────

  async handleDisconnect(client: AppSocket): Promise<void> {
    const { playerId, roomCode, isHost } = client.data;

    if (!playerId || !roomCode) return;

    try {
      // 1. Mark player offline and establish the temporary grace window in Redis
      await this.gameService.markPlayerDisconnected(playerId);
      await this.gameService.createReconnectWindow(playerId);

      this.logger.log(
        JSON.stringify({
          event: 'player_disconnected',
          playerId,
          roomCode,
          socketId: client.id,
          isHost,
        }),
      );

      // 2. Asynchronous Host Migration Orchestration Execution Path
      if (isHost) {
        // Corrected signature signature to pass a standard synchronous callback to setTimeout
        setTimeout(() => {
          // Wrap async business operational paths cleanly inside a standalone block
          const runMigration = async (): Promise<void> => {
            const stillDisconnected =
              !(await this.gameService.canReconnect(playerId));

            if (stillDisconnected) {
              this.logger.log(
                JSON.stringify({
                  event: 'host_migration_triggered',
                  roomCode,
                  message:
                    'Host failed to reconnect within grace window. Executing migration.',
                }),
              );

              const newHost = await this.gameService.migrateHost(roomCode);

              if (newHost) {
                this.server.to(roomCode).emit('v1:room:host_changed', {
                  roomCode,
                  hostId: newHost.playerId,
                  username: newHost.username,
                });
              }
            }
          };

          // Execute async logic chain and securely trap untracked exceptions
          runMigration().catch((err) => {
            const message =
              err instanceof Error
                ? err.message
                : 'Migration process exception.';
            this.logger.error(
              JSON.stringify({
                event: 'host_migration_error',
                roomCode,
                message,
              }),
            );
          });
        }, 30000); // 30 seconds reconnect grace window matching your system cache defaults
      }

      // 3. Centralized validation guard checks for completely empty rooms
      await this.gameService.checkRoomOccupancy(roomCode);

      // 4. Update remaining clients if the room was not dropped entirely
      const roster = await this.gameService.getRoomRoster(roomCode);
      if (roster.length > 0) {
        this.server
          .to(roomCode)
          .emit('v1:room:roster_updated', { players: roster });
      }
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
}
