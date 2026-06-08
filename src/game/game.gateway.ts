import { SubmitDrawingDto } from './dto/submit-drawing.dto';
import { validateDrawingPayloadSize } from './validators/drawing-payload.validator';
import { validateVectorOnlyPayload } from './validators/drawing-content.validator';
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
    // Register the shared automated callback listener
    this.gameService.registerPhaseChangeCallback((roomCode, status) => {
      this.server.to(roomCode).emit('v1:game:phase_changed', {
        roomCode,
        status,
      });
    });

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
   * Temporary isolated debug signature handler to inspect inbound message integrity rules,
   * isolating client serialization faults from structural payload pipeline blockers.
   */
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  )
  @SubscribeMessage('v1:canvas:submit_drawing')
  async handleSubmitDrawing(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() dto: SubmitDrawingDto,
  ): Promise<{
    success: boolean;
    playerId: string;
    strokeCount: number;
  }> {
    const { playerId, roomCode } = client.data;

    validateVectorOnlyPayload(dto);
    validateDrawingPayloadSize(dto);

    const roomState = await this.redis
      .getClient()
      .hgetall(REDIS_KEYS.ROOM_STATE(roomCode));

    if (roomState.status !== RoomStatus.DRAWING) {
      throw new Error(
        `Drawing submissions are only allowed during ${RoomStatus.DRAWING}`,
      );
    }

    const currentRound = Number(roomState.currentRound ?? 1);

    const redisClient = this.redis.getClient();

    const lockKey = REDIS_KEYS.SUBMISSION_LOCK(playerId, currentRound);

    const acquired = await redisClient.set(lockKey, '1', 'EX', 600, 'NX');

    if (!acquired) {
      this.logger.warn(
        JSON.stringify({
          event: 'duplicate_submission_blocked',
          roomCode,
          currentRound,
          playerId,
        }),
      );

      return {
        success: false,
        playerId,
        strokeCount: 0,
      };
    }

    const drawingKey = `sti:v1:room:${roomCode}:round:${currentRound}:player:${playerId}`;

    const submittedSet = REDIS_KEYS.ROUND_SUBMITTED_SET(roomCode, currentRound);

    // Initialize atomic storage runtime pipeline grouping across storage boundaries
    const pipeline = redisClient.pipeline();

    pipeline.set(drawingKey, JSON.stringify(dto.strokes));

    pipeline.sadd(submittedSet, playerId);

    await pipeline.exec();

    // Audit and process runtime submission indices for metrics logging
    const submittedCount = await redisClient.scard(submittedSet);

    this.logger.log(
      JSON.stringify({
        event: 'drawing_submitted',
        roomCode,
        currentRound,
        playerId,
        submittedCount,
      }),
    );

    // Filter roster to evaluate dynamic, connection-aware submission progress thresholds
    const activePlayers = (
      await this.gameService.getRoomRoster(roomCode)
    ).filter((player) => player.connected);

    const activePlayerCount = activePlayers.length;

    if (submittedCount < activePlayerCount) {
      return {
        success: true,
        playerId,
        strokeCount: dto.strokes.length,
      };
    }

    // Secure a short-lived distribution lock to prevent multi-client mutation race conditions
    const transitionLockKey = REDIS_KEYS.ROUND_TRANSITION_LOCK(roomCode);

    const transitionLock = await redisClient.set(
      transitionLockKey,
      '1',
      'EX',
      5,
      'NX',
    );

    if (!transitionLock) {
      this.logger.warn(
        JSON.stringify({
          event: 'transition_lock_blocked',
          roomCode,
          currentRound,
          playerId,
        }),
      );

      return {
        success: true,
        playerId,
        strokeCount: dto.strokes.length,
      };
    }

    // Final player submitted under lock security -> Trigger downstream phase advancement execution
    this.logger.log(
      JSON.stringify({
        event: 'all_players_submitted',
        roomCode,
        currentRound,
        submittedCount,
        activePlayerCount,
      }),
    );

    await this.gameService.advancePhase(roomCode);

    return {
      success: true,
      playerId,
      strokeCount: dto.strokes.length,
    };
  }

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

    await this.gameService.updateRoomSettings(roomCode, dto);

    this.server.to(roomCode).emit('v1:room:settings_changed', dto);
    this.server.to(roomCode).emit('v1:room:settings_updated', dto);
  }

  /**
   * Validates room context eligibility and advances the room status state out of the LOBBY phase.
   * Leverages a short-lived Redis NX lock to guarantee atomicity and prevent double-start race conditions.
   */
  @UseGuards(GatewayGuard)
  @SubscribeMessage('v1:host:start_game')
  async startGame(@ConnectedSocket() client: AppSocket): Promise<void> {
    const { roomCode } = client.data;

    // 1. Acquire distributed lock (5-second expiration window) to prevent rapid multi-clicks
    const redisClient = this.redis.getClient();
    const locked = await redisClient.set(
      REDIS_KEYS.GAME_START_LOCK(roomCode),
      '1',
      'EX',
      5,
      'NX',
    );

    if (!locked) {
      this.logger.warn(
        JSON.stringify({
          event: 'game_start_locked',
          roomCode,
          message:
            'Game start execution dropped due to an active mutation lock.',
        }),
      );
      return;
    }

    // 2. Validate current state status under full mutation isolation
    const status = await this.gameService.getRoomStatus(roomCode);

    if (status !== RoomStatus.LOBBY) {
      return;
    }

    // 3. Commit state changes, advancing phase and initializing the round parameter structure
    await redisClient.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
      status: RoomStatus.DRAWING,
      currentRound: '1',
    });

    // 4. Fetch a unique random prompt based on the room's chosen theme
    const prompt = await this.gameService.getUniquePrompt(roomCode);

    // 5. Broadcast initial round configuration
    // (Note: phase_changed broadcast handled by service callback injection points)
    this.server.to(roomCode).emit('v1:round:started', {
      roomCode,
      round: 1,
      prompt,
    });

    // 6. Schedule downstream automated phase timeout tracking vectors
    const roomState = await this.redis
      .getClient()
      .hgetall(REDIS_KEYS.ROOM_STATE(roomCode));

    const duration = Number(roomState.timerDuration ?? 90);

    await this.gameService.schedulePhaseTransition(roomCode, duration);
  }

  /**
   * Evaluates chronological state flow indices, shifting game rooms cleanly into structural adjacent loops.
   * Handles round iteration payload distributions cleanly if loops step back into DRAWING status configurations.
   */
  @SubscribeMessage('v1:debug:advance_phase')
  async advancePhase(@ConnectedSocket() client: AppSocket): Promise<void> {
    const { roomCode } = client.data;

    // Destructure the returned configuration payload from the newly refactored service method
    const { next, currentRound, prompt } =
      await this.gameService.advancePhase(roomCode);

    // If the room cycled back into a fresh DRAWING phase loop and carries valid configuration parameters, dispatch events
    // (Note: phase_changed broadcast handled by service callback injection points)
    if (next === RoomStatus.DRAWING && prompt) {
      this.server.to(roomCode).emit('v1:round:started', {
        roomCode,
        round: currentRound,
        prompt,
      });
    }
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

      client.data.playerId = playerId;
      client.data.roomCode = roomCode;
      client.data.isHost = isHost;

      const canReconnect = await this.gameService.canReconnect(playerId);

      if (canReconnect) {
        const playerHashKey = REDIS_KEYS.PLAYER_HASH(playerId);
        const existingPlayerRaw = await this.redis.hgetall(playerHashKey);
        client.data.username = existingPlayerRaw.username ?? 'Unknown';

        await this.gameService.markPlayerConnected(playerId);
        await client.join(roomCode);

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

      if (isHost) {
        setTimeout(() => {
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
        }, 30000);
      }

      await this.gameService.checkRoomOccupancy(roomCode);

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
