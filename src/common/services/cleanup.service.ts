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
   * 🌟 NEW HOOK: Soft resets match states to make rooms completely REPLAYABLE.
   * Purges volatile canvas strokes, voting data, and score standings from memory,
   * while keeping the room status shell, core settings configurations, and structural
   * player rosters alive. Sets status back to "LOBBY" and resets the round to 1.
   */
  async resetMatchForPlayAgain(
    roomCode: string,
    totalRounds: number,
    playerIds: string[],
  ): Promise<void> {
    const redis = this.redisService.getClient();
    const pipeline = redis.pipeline();

    // 1. Purge match-dependent round ephemeral metrics (canvases, sets, locks)
    for (let round = 1; round <= totalRounds; round++) {
      pipeline.del(REDIS_KEYS.GALLERY_INDEX(roomCode, round));
      pipeline.del(REDIS_KEYS.GALLERY_ORDER(roomCode, round));
      pipeline.del(REDIS_KEYS.ROUND_SUBMITTED_SET(roomCode, round));

      playerIds.forEach((playerId) => {
        pipeline.del(
          `sti:v1:room:${roomCode}:round:${round}:player:${playerId}`,
        );
        pipeline.del(REDIS_KEYS.SUBMISSION_LOCK(playerId, round));
      });
    }

    // 2. Clear out terminal match metrics
    pipeline.del(REDIS_KEYS.LEADERBOARD(roomCode));
    pipeline.del(REDIS_KEYS.PROMPT_HISTORY(roomCode));
    pipeline.del(REDIS_KEYS.ROUND_TRANSITION_LOCK(roomCode));

    // 3. ATOMIC STATE SHIFT BACK TO LOBBY
    // Instead of deleting ROOM_STATE and ROOM_META, we forcefully roll back progress values
    if (typeof REDIS_KEYS.ROOM_STATE === 'function') {
      // If ROOM_STATE maps to a standalone string key or hash path
      pipeline.hset(REDIS_KEYS.ROOM_STATE(roomCode), 'status', 'LOBBY');
      pipeline.hset(REDIS_KEYS.ROOM_STATE(roomCode), 'currentRound', '1');
      pipeline.hset(REDIS_KEYS.ROOM_STATE(roomCode), 'activePrompt', '');
    } else {
      // Fallback fallback if your REDIS_KEYS uses a standard flat string identifier
      pipeline.set(`sti:v1:room:${roomCode}:status`, 'LOBBY');
      pipeline.set(`sti:v1:room:${roomCode}:currentRound`, '1');
    }

    await pipeline.exec();

    this.log(
      JSON.stringify({
        event: 'match_play_again_initialized',
        roomCode,
        message:
          'Volatile vectors and score leaderboards purged. Room rolled back to LOBBY status configurations.',
      }),
    );
  }

  /**
   * Hook #2: HARD DESTRUCTIVE MATCH WIPE.
   * Clears all game structures deterministically.
   * Run this ONLY when a room is dead, abandoned, or host-migration timers run out.
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
            const errorInstance =
              err instanceof Error ? err : new Error(String(err));
            reject(errorInstance);
          });
      });

      stream.on('error', (err: unknown) => {
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
