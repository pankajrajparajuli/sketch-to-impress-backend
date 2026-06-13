import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.keys';

@Injectable()
export class CleanupService extends Logger {
  constructor(private readonly redisService: RedisService) {
    super(CleanupService.name);
  }

  /**
   * Hook #1: Clears the drawing keys for a specific round across all players.
   * Eliminates the O(N) lookup scan with O(1) targeted key unlinking.
   */
  async cleanupRoundStrokes(
    roomCode: string,
    roundNumber: number,
    playerIds: string[],
  ): Promise<void> {
    const redis = this.redisService.getClient();
    const pipeline = redis.pipeline();

    let deletedKeysCount = 0;

    // Target individual drawing keys deterministically
    playerIds.forEach((playerId) => {
      const drawingKey = `sti:v1:room:${roomCode}:round:${roundNumber}:player:${playerId}`;
      pipeline.del(drawingKey);
      deletedKeysCount++;
    });

    await pipeline.exec();

    this.log(
      JSON.stringify({
        event: 'round_strokes_deleted',
        roomCode,
        roundNumber,
        targetKeysDeleted: deletedKeysCount,
      }),
    );
  }

  /**
   * Hook #2: Clears all game structures deterministically.
   * Iterates through rounds to wipe ephemeral metrics, followed by core room structures.
   */
  async cleanupMatch(
    roomCode: string,
    totalRounds: number,
    playerIds: string[],
  ): Promise<void> {
    const redis = this.redisService.getClient();
    const pipeline = redis.pipeline();

    // 1. Wipe all round-dependent keys
    for (let round = 1; round <= totalRounds; round++) {
      pipeline.del(REDIS_KEYS.GALLERY_INDEX(roomCode, round));
      pipeline.del(REDIS_KEYS.GALLERY_ORDER(roomCode, round));
      pipeline.del(REDIS_KEYS.ROUND_SUBMITTED_SET(roomCode, round));
      pipeline.del(REDIS_KEYS.ROUND_TRANSITION_LOCK(roomCode));

      playerIds.forEach((playerId) => {
        pipeline.del(
          `sti:v1:room:${roomCode}:round:${round}:player:${playerId}`,
        );
        pipeline.del(REDIS_KEYS.SUBMISSION_LOCK(playerId, round));
      });
    }

    // 2. Wipe core room metadata, history, and status trackers
    pipeline.del(REDIS_KEYS.ROOM_META(roomCode));
    pipeline.del(REDIS_KEYS.ROOM_STATE(roomCode));
    pipeline.del(REDIS_KEYS.ROOM_PLAYERS(roomCode));
    pipeline.del(REDIS_KEYS.LEADERBOARD(roomCode));
    pipeline.del(REDIS_KEYS.PROMPT_HISTORY(roomCode));
    pipeline.del(REDIS_KEYS.GAME_START_LOCK(roomCode));

    // Also clear individual player connection data if required
    playerIds.forEach((playerId) => {
      pipeline.del(REDIS_KEYS.PLAYER_HASH(playerId));
      pipeline.del(REDIS_KEYS.PLAYER_RECONNECT(playerId));
    });

    await pipeline.exec();

    this.log(
      JSON.stringify({
        event: 'match_cleanup_complete',
        roomCode,
        totalRounds,
        message: 'All targeted state keys deterministically flushed.',
      }),
    );
  }

  /**
   * Global Reaper Hook: Automatically sweeps up ALL keys belonging to a room code.
   * Leverages non-blocking stream iteration (`scanStream`) wrapped in a Promise structure.
   * Safe-casts and maps all errors explicitly to native Error classes to satisfy ESLint.
   */
  async reapOrphanedKeys(roomCode: string): Promise<void> {
    const redis = this.redisService.getClient();

    const stream = redis.scanStream({
      match: `sti:v1:room:${roomCode}:*`,
      count: 100,
    });

    const keysToDelete: string[] = [];

    stream.on('data', (keys: string[]) => {
      keysToDelete.push(...keys);
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('end', () => {
        if (keysToDelete.length === 0) {
          resolve();
          return;
        }

        redis
          .del(...keysToDelete)
          .then(() => {
            this.log(
              JSON.stringify({
                event: 'reaper_cleanup_executed',
                roomCode,
                keysCount: keysToDelete.length,
                message:
                  'All orphaned and dynamic keys successfully purged by the global reaper.',
              }),
            );
            resolve();
          })
          .catch((err: unknown) => {
            // Guarantee an instance of Error for rule compliance
            const errorInstance =
              err instanceof Error ? err : new Error(String(err));
            reject(errorInstance);
          });
      });

      stream.on('error', (err: unknown) => {
        // Guarantee an instance of Error for rule compliance
        const errorInstance =
          err instanceof Error ? err : new Error(String(err));
        reject(errorInstance);
      });
    }).catch((err: unknown) => {
      const message =
        err instanceof Error ? err.message : 'Unknown scanStream exception';
      this.error(
        JSON.stringify({
          event: 'reaper_cleanup_failed',
          roomCode,
          message,
        }),
      );
    });
  }
}
