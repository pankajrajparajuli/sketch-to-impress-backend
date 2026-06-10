import { SubmitDrawingDto } from './dto/submit-drawing.dto';
import { CastVoteDto } from './dto/cast-vote.dto';
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
import { OnEvent } from '@nestjs/event-emitter';
import * as jwt from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';

import { GatewayGuard } from '../common/guards/gateway.guard';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomStatus } from '../rooms/enums/room-status.enum';
import { GameService } from './game.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { GAME_TIMERS } from './constants/game-timers';

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

// ─── Strongly Typed Gallery Struct mapping to avoid ESLint 'any' warnings ───
interface ExtendedGalleryEntry {
  drawingId: string;
  playerId: string;
  strokes: unknown[];
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
  private readonly galleryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly redis: RedisService,
    private readonly gameService: GameService,
  ) {}

  afterInit(): void {
    this.gameService.registerPhaseChangeCallback((roomCode, status) => {
      this.redis
        .getClient()
        .hgetall(REDIS_KEYS.ROOM_STATE(roomCode))
        .then(async (roomState) => {
          this.server.to(roomCode).emit('v1:game:phase_changed', {
            roomCode,
            status,
          });

          if (status === RoomStatus.GALLERY) {
            const currentRound = Number(roomState.currentRound ?? 1);
            await this.startGalleryCarousel(roomCode, currentRound);
          } else if (status === RoomStatus.DRAWING) {
            // Mid-game round advancement for round 2, 3, etc.
            const currentRound = Number(roomState.currentRound ?? 1);
            const prompt = await this.gameService.getUniquePrompt(roomCode);

            this.server.to(roomCode).emit('v1:round:started', {
              roomCode,
              round: currentRound,
              prompt,
              roundEndTimestamp: Number(roomState.roundEndTimestamp),
              serverTime: Date.now(),
            });
          }
        })
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error(`[Phase change pipeline crash]: ${errMsg}`);
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

  private async startGalleryCarousel(
    roomCode: string,
    round: number,
  ): Promise<void> {
    const activeTimer = this.galleryTimers.get(roomCode);
    if (activeTimer) {
      clearTimeout(activeTimer);
      this.galleryTimers.delete(roomCode);
    }

    const gallery = await this.gameService.getGalleryOrder(roomCode, round);

    if (gallery.length === 0) {
      const standings = await this.gameService.buildRoundStandings(roomCode);

      this.server.to(roomCode).emit('v1:game:round_complete', {
        roomCode,
        round,
        standings,
      });

      await this.gameService.advancePhase(roomCode);
      return;
    }

    // LOAD PREVIOUS STATE FROM REDIS INSTANCE INSTEAD OF INITIALIZING TO 0
    let index = await this.gameService.getGalleryIndex(roomCode, round);
    const redisClient = this.redis.getClient();

    const runCarouselStep = async () => {
      if (index >= gallery.length) {
        this.galleryTimers.delete(roomCode);
        await redisClient.hdel(
          REDIS_KEYS.ROOM_STATE(roomCode),
          'activeDrawingId',
        );
        // CLEAN UP THE GALLERY INDEX ON COMPLETED CAROUSEL LOOP
        await this.gameService.deleteGalleryIndex(roomCode, round);
        await this.gameService.advancePhase(roomCode);
        return;
      }

      const drawing = gallery[index];

      if (!drawing) {
        this.galleryTimers.delete(roomCode);
        await redisClient.hdel(
          REDIS_KEYS.ROOM_STATE(roomCode),
          'activeDrawingId',
        );
        await this.gameService.deleteGalleryIndex(roomCode, round);
        const standings = await this.gameService.buildRoundStandings(roomCode);
        this.server.to(roomCode).emit('v1:game:round_complete', {
          roomCode,
          round,
          standings,
        });

        await this.gameService.advancePhase(roomCode);
        return;
      }

      const position = index + 1;
      const total = gallery.length;

      const safeDrawing = drawing as unknown as ExtendedGalleryEntry;
      const targetDrawingId = safeDrawing.drawingId;

      await redisClient.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
        activeDrawingId: targetDrawingId,
      });

      const anonymousDrawing = {
        drawingId: safeDrawing.drawingId,
        strokes: safeDrawing.strokes,
      };

      // Calculate and persist carousel step end timestamp
      const galleryEndTimestamp =
        Date.now() + GAME_TIMERS.VOTING_SECONDS_PER_CANVAS * 1000;

      await redisClient.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
        galleryEndTimestamp: String(galleryEndTimestamp),
      });

      this.server.to(roomCode).emit('v1:gallery:next_canvas', {
        roomCode,
        round,
        position,
        total,
        drawing: anonymousDrawing,
        votingSeconds: GAME_TIMERS.VOTING_SECONDS_PER_CANVAS,
        galleryEndTimestamp,
        serverTime: Date.now(),
      });

      // INCREMENT AND IMMEDIATELY UPDATE REDIS
      index++;
      await this.gameService.setGalleryIndex(roomCode, round, index);

      const timer = setTimeout(() => {
        runCarouselStep().catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Carousel step failure: ${errMsg}`);
        });
      }, GAME_TIMERS.VOTING_SECONDS_PER_CANVAS * 1000);

      this.galleryTimers.set(roomCode, timer);
    };

    await runCarouselStep();
  }

  // HANDLERS FOR EXTERNAL DISCONNECTIONS DURING GALLERY PHASE TO RECALCULATE VOTER MAJORITY AND ADVANCE CAROUSEL IF NEEDED

  private async checkGalleryCompletion(
    roomCode: string,
    currentRound: number,
    drawingId: string,
  ): Promise<boolean> {
    const redisClient = this.redis.getClient();

    const gallery = await this.gameService.getGalleryOrder(
      roomCode,
      currentRound,
    );
    const safeGallery = gallery as unknown as ExtendedGalleryEntry[];

    const drawing = safeGallery.find((g) => g.drawingId === drawingId);
    if (!drawing) {
      return false;
    }

    const roster = await this.gameService.getRoomRoster(roomCode);

    // Filter out the artist from the baseline calculation
    const eligibleVoters = roster.filter(
      (player) => player.playerId !== drawing.playerId,
    ).length;

    const completedVoters = await redisClient.scard(
      REDIS_KEYS.VOTERS(roomCode, currentRound, drawingId),
    );

    this.logger.log(
      JSON.stringify({
        event: 'gallery_vote_progress',
        roomCode,
        currentRound,
        drawingId,
        eligibleVoters,
        completedVoters,
      }),
    );

    return completedVoters >= eligibleVoters;
  }

  private async handleGalleryDisconnect(roomCode: string): Promise<void> {
    const redisClient = this.redis.getClient();

    const roomState = await redisClient.hgetall(
      REDIS_KEYS.ROOM_STATE(roomCode),
    );

    if (roomState.status !== RoomStatus.GALLERY) {
      return;
    }

    const activeDrawingId = roomState.activeDrawingId;

    if (!activeDrawingId) {
      return;
    }

    const currentRound = Number(roomState.currentRound ?? 1);

    const complete = await this.checkGalleryCompletion(
      roomCode,
      currentRound,
      activeDrawingId,
    );

    if (!complete) {
      return;
    }

    // Race Condition Protection: Check atomic mutation lock
    const lockKey = REDIS_KEYS.GALLERY_ADVANCE_LOCK(
      roomCode,
      currentRound,
      activeDrawingId,
    );

    const lock = await redisClient.set(lockKey, '1', 'EX', 5, 'NX');

    if (!lock) {
      this.logger.warn(
        JSON.stringify({
          event: 'gallery_advance_lock_blocked',
          roomCode,
          currentRound,
          drawingId: activeDrawingId,
          context: 'handleGalleryDisconnect',
        }),
      );
      return;
    }

    this.logger.log(
      JSON.stringify({
        event: 'gallery_disconnect_recalculation',
        roomCode,
        currentRound,
        drawingId: activeDrawingId,
      }),
    );

    await this.advanceGalleryCanvas(roomCode, currentRound);
  }

  @OnEvent('PLAYER_LEFT')
  async handlePlayerLeftEvent(payload: {
    roomCode: string;
    playerId: string;
  }): Promise<void> {
    this.logger.log(
      JSON.stringify({
        event: 'player_left_event_received',
        roomCode: payload.roomCode,
        playerId: payload.playerId,
        message:
          'Decoupled event listener intercepting room disconnection for dynamic recalculation.',
      }),
    );
    await this.handleGalleryDisconnect(payload.roomCode);
  }

  private async advanceGalleryCanvas(
    roomCode: string,
    round: number,
  ): Promise<void> {
    const timer = this.galleryTimers.get(roomCode);

    if (timer) {
      clearTimeout(timer);
      this.galleryTimers.delete(roomCode);
    }

    await this.startGalleryCarousel(roomCode, round);
  }

  // ── WebSocket Ingestion Pipeline Event Listeners ─────────────────────────────

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
          strokeCount: 0,
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

    const pipeline = redisClient.pipeline();
    pipeline.set(drawingKey, JSON.stringify(dto.strokes));
    pipeline.sadd(submittedSet, playerId);
    await pipeline.exec();

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
          strokeCount: dto.strokes.length,
        }),
      );

      return {
        success: true,
        playerId,
        strokeCount: dto.strokes.length,
      };
    }

    this.logger.log(
      JSON.stringify({
        event: 'all_players_submitted',
        roomCode,
        currentRound,
        submittedCount,
        activePlayerCount,
      }),
    );

    const gallery = await this.gameService.buildGalleryPayload(
      roomCode,
      currentRound,
    );

    await this.gameService.cacheGalleryOrder(roomCode, currentRound, gallery);
    await this.gameService.advancePhase(roomCode);

    return {
      success: true,
      playerId,
      strokeCount: dto.strokes.length,
    };
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('v1:vote:cast_stars')
  async castVote(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() dto: CastVoteDto,
  ): Promise<{ success: boolean }> {
    const { playerId, roomCode } = client.data;
    const redisClient = this.redis.getClient();

    const roomState = await redisClient.hgetall(
      REDIS_KEYS.ROOM_STATE(roomCode),
    );

    if (roomState.status !== RoomStatus.GALLERY) {
      throw new Error('Voting is only permitted during the GALLERY phase.');
    }

    const activeDrawingId = roomState.activeDrawingId;
    if (!activeDrawingId) {
      this.logger.warn(
        `Player ${playerId} voted but no active drawing index exists.`,
      );
      return { success: false };
    }

    const currentRound = Number(roomState.currentRound ?? 1);
    const votersKey = REDIS_KEYS.VOTERS(
      roomCode,
      currentRound,
      activeDrawingId,
    );

    const gallery = await this.gameService.getGalleryOrder(
      roomCode,
      currentRound,
    );

    const safeGallery = gallery as unknown as ExtendedGalleryEntry[];
    const targetItem = safeGallery.find((g) => g.drawingId === activeDrawingId);
    if (!targetItem) {
      return { success: false };
    }

    // 1. VALIDATION BARRIER: Block out self-voters before any state mutation
    if (targetItem.playerId === playerId) {
      this.logger.warn(
        JSON.stringify({
          event: 'self_vote_blocked',
          roomCode,
          currentRound,
          drawingId: activeDrawingId,
          playerId,
        }),
      );
      return { success: false };
    }

    // 2. STATE MUTATION: Try adding voter to set safely
    const added = await redisClient.sadd(votersKey, playerId);

    if (added === 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'duplicate_vote_blocked',
          roomCode,
          currentRound,
          drawingId: activeDrawingId,
          playerId,
        }),
      );
      return { success: false };
    }

    // 3. PERSIST SCORES AND LOG REWARDS
    if (targetItem && targetItem.playerId) {
      const leaderboardKey = REDIS_KEYS.LEADERBOARD(roomCode);
      await redisClient.hincrby(leaderboardKey, targetItem.playerId, dto.stars);
    }

    this.logger.log(
      JSON.stringify({
        event: 'vote_recorded',
        roomCode,
        currentRound,
        drawingId: activeDrawingId,
        playerId,
        stars: dto.stars,
      }),
    );

    // ─── EARLY ADVANCE CHECKS ───────────────────────────────
    const complete = await this.checkGalleryCompletion(
      roomCode,
      currentRound,
      activeDrawingId,
    );

    if (complete) {
      const lockKey = REDIS_KEYS.GALLERY_ADVANCE_LOCK(
        roomCode,
        currentRound,
        activeDrawingId,
      );

      const lock = await redisClient.set(lockKey, '1', 'EX', 5, 'NX');

      if (!lock) {
        this.logger.warn(
          JSON.stringify({
            event: 'gallery_advance_lock_blocked',
            roomCode,
            currentRound,
            drawingId: activeDrawingId,
            context: 'castVote',
          }),
        );

        return { success: true };
      }

      this.logger.log(
        JSON.stringify({
          event: 'gallery_early_advance',
          roomCode,
          currentRound,
          drawingId: activeDrawingId,
        }),
      );

      await this.advanceGalleryCanvas(roomCode, currentRound);
    }

    return { success: true };
  }

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

  @UseGuards(GatewayGuard)
  @SubscribeMessage('v1:host:start_game')
  async startGame(@ConnectedSocket() client: AppSocket): Promise<void> {
    const { roomCode } = client.data;

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

    const status = await this.gameService.getRoomStatus(roomCode);

    if (status !== RoomStatus.LOBBY) {
      return;
    }

    await redisClient.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
      status: RoomStatus.DRAWING,
      currentRound: '1',
    });

    const prompt = await this.gameService.getUniquePrompt(roomCode);

    const roomState = await this.redis
      .getClient()
      .hgetall(REDIS_KEYS.ROOM_STATE(roomCode));

    const duration = Number(roomState.timerDuration ?? 90);

    // Schedule phase transition sets the roundEndTimestamp within the service state layer
    await this.gameService.schedulePhaseTransition(roomCode, duration);

    // Refetch the fresh state containing the set timestamp
    const updatedRoomState = await redisClient.hgetall(
      REDIS_KEYS.ROOM_STATE(roomCode),
    );

    this.server.to(roomCode).emit('v1:round:started', {
      roomCode,
      round: 1,
      prompt,
      roundEndTimestamp: Number(updatedRoomState.roundEndTimestamp),
      serverTime: Date.now(),
    });
  }

  @SubscribeMessage('v1:debug:advance_phase')
  async advancePhase(@ConnectedSocket() client: AppSocket): Promise<void> {
    const { roomCode } = client.data;
    await this.gameService.advancePhase(roomCode);
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
