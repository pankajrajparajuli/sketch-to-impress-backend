import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomPlayer } from './interfaces/v1-room-player.interface';
import {
  V1ReconnectState,
  LeaderboardEntry,
} from './interfaces/v1-reconnect-state.interface';
import { RoomStatus } from '../rooms/enums/room-status.enum';
import { PROMPTS, PromptTheme } from './constants/prompts';

// Fallback constant configuration for the grace period windows
const RECONNECT_GRACE_SECONDS = 30;

@Injectable()
export class GameService {
  constructor(private readonly redisService: RedisService) {}

  /**
   * Retrieves all prompt IDs or strings that have already been served to this room.
   */
  async getUsedPrompts(roomCode: string): Promise<string[]> {
    const redis = this.redisService.getClient();

    return redis.smembers(REDIS_KEYS.PROMPT_HISTORY(roomCode));
  }

  /**
   * Pulls the assigned room theme configuration from state, falling back to 'RANDOM'.
   */
  async getRoomTheme(roomCode: string): Promise<PromptTheme> {
    const redis = this.redisService.getClient();

    const roomState = await redis.hgetall(REDIS_KEYS.ROOM_STATE(roomCode));
    const theme = roomState.theme ?? 'RANDOM';

    if (
      theme !== 'ANIME' &&
      theme !== 'CARTOON' &&
      theme !== 'GAMING' &&
      theme !== 'RANDOM'
    ) {
      return 'RANDOM';
    }

    return theme;
  }

  /**
   * Selects an unplayed prompt based on the room theme, tracks it in history, and flags it as active.
   */
  async getUniquePrompt(roomCode: string): Promise<string> {
    const redis = this.redisService.getClient();

    const theme = await this.getRoomTheme(roomCode);
    const usedPrompts = await this.getUsedPrompts(roomCode);

    const availablePrompts = PROMPTS[theme].filter(
      (prompt) => !usedPrompts.includes(prompt),
    );

    if (availablePrompts.length === 0) {
      throw new Error(`Prompt pool exhausted for ${theme}`);
    }

    const randomIndex = Math.floor(Math.random() * availablePrompts.length);
    const prompt = availablePrompts[randomIndex];

    // Explicit validation step to reassure the TS compiler that 'prompt' is strictly a string
    if (!prompt) {
      throw new Error(`Failed to retrieve a valid prompt from the pool.`);
    }

    const pipeline = redis.pipeline();

    pipeline.sadd(REDIS_KEYS.PROMPT_HISTORY(roomCode), prompt);
    pipeline.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
      activePrompt: prompt,
    });

    await pipeline.exec();

    return prompt;
  }

  /**
   * Directly mutates the room phase status property within the Redis room meta state hash.
   */
  async updateRoomStatus(roomCode: string, status: RoomStatus): Promise<void> {
    const redis = this.redisService.getClient();

    await redis.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
      status,
    });
  }

  /**
   * Retrieves the current room status value string, defaulting back to LOBBY on non-existent properties.
   */
  async getRoomStatus(roomCode: string): Promise<RoomStatus> {
    const redis = this.redisService.getClient();

    const status = await redis.hget(REDIS_KEYS.ROOM_STATE(roomCode), 'status');

    return (status as RoomStatus) ?? RoomStatus.LOBBY;
  }

  /**
   * Cycles the target room status context forward to its chronologically adjacent game engine phase.
   */
  async advancePhase(roomCode: string): Promise<RoomStatus> {
    const current = await this.getRoomStatus(roomCode);
    let next: RoomStatus;

    switch (current) {
      case RoomStatus.LOBBY:
        next = RoomStatus.DRAWING;
        break;

      case RoomStatus.DRAWING:
        next = RoomStatus.GALLERY;
        break;

      case RoomStatus.GALLERY:
        next = RoomStatus.ROUND_RESULTS;
        break;

      case RoomStatus.ROUND_RESULTS:
        next = RoomStatus.FINAL_RESULTS;
        break;

      default:
        next = RoomStatus.FINAL_RESULTS;
    }

    await this.updateRoomStatus(roomCode, next);
    return next;
  }

  /**
   * Updates dynamic match constraints and parameters inside the volatile Redis room meta hash.
   */
  async updateRoomSettings(
    roomCode: string,
    settings: {
      timerDuration: number;
      totalRounds: number;
      theme: string;
    },
  ): Promise<void> {
    const redis = this.redisService.getClient();

    await redis.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
      timerDuration: String(settings.timerDuration),
      totalRounds: String(settings.totalRounds),
      theme: settings.theme,
    });
  }

  /**
   * Adds a user to the real-time room set registry and initializes their configuration hash map.
   */
  async addPlayerToRoster(
    roomCode: string,
    playerId: string,
    username: string,
    isHost: boolean,
  ): Promise<void> {
    const redis = this.redisService.getClient();
    const pipeline = redis.pipeline();

    pipeline.sadd(REDIS_KEYS.ROOM_PLAYERS(roomCode), playerId);

    pipeline.hset(REDIS_KEYS.PLAYER_HASH(playerId), {
      playerId,
      username,
      isHost: String(isHost),
      connected: 'true',
    });

    await pipeline.exec();
  }

  /**
   * Retrieves structural entity details for all tracked players within an active room roster via parallel pipelines.
   */
  async getRoomRoster(roomCode: string): Promise<RoomPlayer[]> {
    const redis = this.redisService.getClient();

    const playerIds = await redis.smembers(REDIS_KEYS.ROOM_PLAYERS(roomCode));

    if (!playerIds || playerIds.length === 0) {
      return [];
    }

    const pipeline = redis.pipeline();

    playerIds.forEach((playerId) => {
      pipeline.hgetall(REDIS_KEYS.PLAYER_HASH(playerId));
    });

    const results = await pipeline.exec();

    if (!results) {
      return [];
    }

    return (
      results
        // 1. Extract the raw object from the pipeline response tuple [error, result]
        .map((result) => result[1] as Record<string, string> | null)
        // 2. Filter out null or completely empty objects
        .filter((player): player is Record<string, string> => !!player)
        // 3. Map to RoomPlayer, using nullish coalescing to guarantee strict string types
        .map((player) => ({
          playerId: player.playerId ?? '',
          username: player.username ?? '',
          isHost: player.isHost === 'true',
          connected: player.connected === 'true',
        }))
    );
  }

  /**
   * Flips a player's inner state hash reference status value to disconnected.
   */
  async markPlayerDisconnected(playerId: string): Promise<void> {
    const redis = this.redisService.getClient();

    await redis.hset(REDIS_KEYS.PLAYER_HASH(playerId), {
      connected: 'false',
    });
  }

  /**
   * Spawns a temporary expiration string flag in Redis acting as a structural guard window.
   */
  async createReconnectWindow(playerId: string): Promise<void> {
    const redis = this.redisService.getClient();

    await redis.set(
      REDIS_KEYS.PLAYER_RECONNECT(playerId),
      'pending',
      'EX',
      RECONNECT_GRACE_SECONDS,
    );
  }

  /**
   * Confirms whether a reconnect grace period window has expired or remains active.
   */
  async canReconnect(playerId: string): Promise<boolean> {
    const redis = this.redisService.getClient();

    const exists = await redis.exists(REDIS_KEYS.PLAYER_RECONNECT(playerId));

    return exists === 1;
  }

  /**
   * Atomic transaction pipeline that reverts connected states and wipes out transient window tracking keys.
   */
  async markPlayerConnected(playerId: string): Promise<void> {
    const redis = this.redisService.getClient();
    const pipeline = redis.pipeline();

    pipeline.hset(REDIS_KEYS.PLAYER_HASH(playerId), {
      connected: 'true',
    });

    pipeline.del(REDIS_KEYS.PLAYER_RECONNECT(playerId));

    await pipeline.exec();
  }

  /**
   * Filters the retrieved room roster to return only actively connected session participants.
   */
  async getConnectedPlayers(roomCode: string): Promise<RoomPlayer[]> {
    const roster = await this.getRoomRoster(roomCode);
    return roster.filter((player) => player.connected);
  }

  /**
   * Scans for all keys matching the system wildcard namespace assigned to a unique room session
   * and purges them completely from memory storage.
   */
  async cleanupRoom(roomCode: string): Promise<void> {
    const redis = this.redisService.getClient();

    const keys = await redis.keys(`sti:v1:room:${roomCode}:*`);

    if (keys.length === 0) {
      return;
    }

    await redis.del(...keys);
  }

  /**
   * Automatically promotes the next available connected player to room host when the current host leaves.
   * If no connected players are found, executes an full workspace cluster cleanup.
   */
  async migrateHost(roomCode: string): Promise<RoomPlayer | null> {
    const redis = this.redisService.getClient();
    const activePlayers = await this.getConnectedPlayers(roomCode);

    const newHost = activePlayers[0];

    if (!newHost) {
      await this.cleanupRoom(roomCode);
      return null;
    }

    await redis.hset(REDIS_KEYS.PLAYER_HASH(newHost.playerId), {
      isHost: 'true',
    });

    return newHost;
  }

  /**
   * Audits active socket connection count within a targeted room code, initiating complete engine wipeouts
   * if the cluster registry evaluates down to zero remaining connections.
   */
  async checkRoomOccupancy(roomCode: string): Promise<void> {
    const connectedPlayers = await this.getConnectedPlayers(roomCode);

    if (connectedPlayers.length === 0) {
      await this.cleanupRoom(roomCode);
    }
  }

  /**
   * Constructs a contextual structural matrix state mapping snapshot for a reconnecting player node.
   */
  async buildReconnectSnapshot(
    roomCode: string,
    playerId: string,
  ): Promise<V1ReconnectState> {
    const redis = this.redisService.getClient();

    const state = await redis.hgetall(REDIS_KEYS.ROOM_STATE(roomCode));
    const roster = await this.getRoomRoster(roomCode);
    const leaderboardRaw = await redis.hgetall(
      REDIS_KEYS.LEADERBOARD(roomCode),
    );

    const endTimestamp = Number(state.roundEndTimestamp ?? 0);
    const remainingTime =
      endTimestamp > 0
        ? Math.max(0, Math.ceil((endTimestamp - Date.now()) / 1000))
        : 0;

    const leaderboard: LeaderboardEntry[] = roster.map((p) => ({
      playerId: p.playerId,
      username: p.username,
      stars: parseInt(leaderboardRaw[p.playerId] ?? '0', 10),
    }));

    return {
      roomCode,
      playerId,
      phase: (state.status as RoomStatus) ?? RoomStatus.LOBBY,
      currentRound: Number(state.currentRound ?? 1),
      totalRounds: Number(state.totalRounds ?? 3),
      timerDuration: Number(state.timerDuration ?? 90),
      theme: (state.theme as PromptTheme) ?? 'RANDOM',
      remainingTime,
      activePrompt: state.activePrompt ?? null,
      leaderboard,
      players: roster,
    };
  }
}
