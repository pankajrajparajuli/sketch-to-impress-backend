import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';

export interface ActiveRoomDashboardRow {
  roomCode: string;
  status: string;
  currentRound: number;
  playerCount: number;
  activePrompt: string;
}

@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Scans and aggregates structural operational data for all active game rooms.
   */
  async getLiveRoomsReport(): Promise<ActiveRoomDashboardRow[]> {
    const redis = this.redisService.getClient();

    // Find all core state hashes matching your room naming scheme
    const stream = redis.scanStream({
      match: 'sti:v1:room:*:state',
      count: 100,
    });

    const roomCodes: string[] = [];

    stream.on('data', (keys: string[]) => {
      keys.forEach((key) => {
        const segments = key.split(':');
        if (segments.length >= 4 && typeof segments[3] === 'string') {
          roomCodes.push(segments[3]); // Safely extract room code
        }
      });
    });

    // Wait for the scanning stream loop to complete entirely
    await new Promise<void>((resolve, reject) => {
      stream.on('end', () => resolve());
      stream.on('error', (err) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    });

    const report: ActiveRoomDashboardRow[] = [];

    // Hydrate each room code with real-time state configurations
    for (const roomCode of roomCodes) {
      try {
        const stateKey = REDIS_KEYS.ROOM_STATE(roomCode);
        const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);

        // Run queries concurrently for efficiency per individual room
        const [stateMap, playerCount] = await Promise.all([
          redis.hgetall(stateKey),
          redis.scard(playersKey),
        ]);

        if (Object.keys(stateMap).length > 0) {
          report.push({
            roomCode,
            status: stateMap.status ?? 'UNKNOWN',
            currentRound: Number(stateMap.currentRound ?? 0),
            playerCount: playerCount,
            activePrompt: stateMap.activePrompt ?? 'None',
          });
        }
      } catch (err) {
        this.logger.error(
          `Failed aggregating live dashboard data for room ${roomCode}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return report;
  }
}
