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

  /**
   * Runs globally every 10 minutes to scan for and destroy abandoned rooms.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async reapDeadRooms(): Promise<void> {
    this.logger.log('Global Room Reaper execution cycle started.');
    const redis = this.redisService.getClient();

    // Scan for all active room state keys in the system
    const stream = redis.scanStream({
      match: 'sti:v1:room:*:state',
      count: 100,
    });

    const activeRoomCodes: string[] = [];

    stream.on('data', (keys: string[]) => {
      keys.forEach((key) => {
        const segments = key.split(':');
        // Safely check both the index structure length and check that the targeted item is a valid string
        if (segments.length >= 4 && typeof segments[3] === 'string') {
          activeRoomCodes.push(segments[3]); // TypeScript now knows this is definitively a string
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('end', () => {
        resolve();
      });
      stream.on('error', (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    })
      .then(async () => {
        for (const roomCode of activeRoomCodes) {
          try {
            const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);
            const playerCount = await redis.scard(playersKey);

            // If player count is 0 or the roster tracking key doesn't exist, purge it
            if (playerCount === 0) {
              this.logger.warn(
                `Room ${roomCode} detected as empty. Initiating complete purge.`,
              );
              await this.cleanupService.reapOrphanedKeys(roomCode);
            }
          } catch (roomErr) {
            this.logger.error(
              `Failed evaluation check for room code ${roomCode}: ${
                roomErr instanceof Error ? roomErr.message : String(roomErr)
              }`,
            );
          }
        }
        this.logger.log(
          'Global Room Reaper execution cycle finalized smoothly.',
        );
      })
      .catch((err: Error) => {
        this.logger.error(
          `Global Room Reaper failed during discovery scan: ${err.message}`,
        );
      });
  }
}
