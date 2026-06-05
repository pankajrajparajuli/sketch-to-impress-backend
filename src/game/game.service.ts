import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomPlayer } from './interfaces/v1-room-player.interface';

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
}
