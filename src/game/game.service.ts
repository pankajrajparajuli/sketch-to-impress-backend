import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomPlayer } from './interfaces/v1-room-player.interface';
import {
  V1ReconnectState,
  LeaderboardEntry,
} from './interfaces/v1-reconnect-state.interface';
import { RoomStatus } from '../rooms/enums/room-status.enum';

// Fallback constant configuration for the grace period windows
const RECONNECT_GRACE_SECONDS = 30;

@Injectable()
export class GameService {
  constructor(private readonly redisService: RedisService) {}

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

    // Build standard, typed LeaderboardEntry schema matches using player data from our roster
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
      theme: state.theme ?? 'Cartoon',
      remainingTime,
      activePrompt: state.activePrompt ?? null,
      leaderboard,
      players: roster,
    };
  }
}
