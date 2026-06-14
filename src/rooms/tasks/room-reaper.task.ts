import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../../redis/redis.service';
import { CleanupService } from '../../common/services/cleanup.service';
import { REDIS_KEYS } from '../../redis/redis.keys';

@Injectable()
export class RoomReaperTask {
  private readonly logger = new Logger(RoomReaperTask.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly cleanupService: CleanupService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reapDeadRooms(): Promise<void> {
    this.logger.log('Global Room Reaper execution cycle started.');
    const redis = this.redisService.getClient();
    const activeRoomCodes = new Set<string>();

    try {
      // 1. Mirror the dashboard scan exactly: target structural state keys safely
      await new Promise<void>((resolve, reject) => {
        const stream = redis.scanStream({
          match: 'sti:v1:room:*:state', // Matches exactly what the dashboard finds
          count: 100,
        });

        stream.on('data', (keys: string[]) => {
          for (const key of keys) {
            const segments = key.split(':');
            // Index 3 maps directly to the room code: ["sti", "v1", "room", "ROOMCODE", "state"]
            if (segments.length >= 5 && segments[3]) {
              activeRoomCodes.add(segments[3].toUpperCase());
            }
          }
        });

        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      this.logger.log(
        `Discovery complete. Found ${activeRoomCodes.size} room codes matching operational state keys.`,
      );

      // 2. Evaluate each discovered room code sequentially
      for (const roomCode of activeRoomCodes) {
        try {
          const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);

          // Fetch the roster count and check if the state map exists
          const [playerCount, stateMap] = await Promise.all([
            redis.scard(playersKey),
            redis.hgetall(REDIS_KEYS.ROOM_STATE(roomCode)),
          ]);

          // Identify Zombie and Ghost rooms (Mirroring dashboard logic parameters)
          const hasNoRoster = !playerCount || playerCount === 0;
          const isStateEmpty = !stateMap || Object.keys(stateMap).length === 0;

          if (hasNoRoster || isStateEmpty) {
            this.logger.warn(
              `Room [${roomCode}] flagged for reaping. Reason: Roster Count = ${playerCount}, State Map Exists = ${!isStateEmpty}.`,
            );

            // Execute the cleanup flow from cleanup.service.ts or your local holistic function
            await this.executeHolisticPurge(roomCode);
          }
        } catch (roomErr) {
          this.logger.error(
            `Failed evaluation check for room code ${roomCode}: ${
              roomErr instanceof Error ? roomErr.message : String(roomErr)
            }`,
          );
        }
      }

      this.logger.log('Global Room Reaper execution cycle finalized smoothly.');
    } catch (err) {
      this.logger.error(
        `Global Room Reaper failed during discovery scan: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Targets and destroys every single trace of the room code keyspace
   */
  private async executeHolisticPurge(roomCode: string): Promise<void> {
    const redis = this.redisService.getClient();
    const keysToDelete = new Set<string>();

    // Using explicit prefix namespaces from your cleanup architecture to avoid missing entries
    const patterns = [
      `sti:v1:room:${roomCode}:*`,
      `sti:v1:room:${roomCode}`,
      `*:${roomCode}:*`,
      `*player:${roomCode}*`,
    ];

    for (const pattern of patterns) {
      await new Promise<void>((resolve) => {
        const scanStream = redis.scanStream({ match: pattern, count: 250 });

        scanStream.on('data', (keys: string[]) => {
          keys.forEach((k) => keysToDelete.add(k));
        });
        scanStream.on('end', () => resolve());
        scanStream.on('error', () => resolve());
      });
    }

    if (keysToDelete.size > 0) {
      const targetList = Array.from(keysToDelete);
      const deletedCount = await redis.del(...targetList);
      this.logger.log(
        `[HolisticPurge] Success! Instantly purged ${deletedCount} abandoned keys for room ${roomCode}.`,
      );
    } else {
      this.logger.warn(
        `[HolisticPurge] No target keys physically found in Redis for room ${roomCode}.`,
      );
    }
  }
}
