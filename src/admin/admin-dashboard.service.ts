import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';

export interface ActiveRoomDashboardRow {
  roomCode: string;
  status: string;
  currentRound: number;
  playerCount: number;
  activePrompt: string;
  isZombie: boolean; // 🧟 Track if this is a ghost/zombie room
  zombieReason: string; // 💬 Explains why it's considered a zombie
}

@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Scans and aggregates structural operational data for all active game rooms,
   * including ghost/zombie rooms that have zero active or connected users.
   */
  async getLiveRoomsReport(): Promise<ActiveRoomDashboardRow[]> {
    const redis = this.redisService.getClient();
    const roomCodes: string[] = [];

    // 1. Properly await the scanning pattern using the stream event pattern
    await new Promise<void>((resolve, reject) => {
      const stream = redis.scanStream({
        match: 'sti:v1:room:*:state',
        count: 100,
      });

      stream.on('data', (keys: string[]) => {
        for (const key of keys) {
          const segments = key.split(':');
          // e.g. ["sti", "v1", "room", "ABCD", "state"] -> segments[3] is the roomCode
          if (segments.length >= 5 && segments[3]) {
            roomCodes.push(segments[3]);
          }
        }
      });

      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
    });

    const report: ActiveRoomDashboardRow[] = [];

    // 2. Hydrate all discovered room codes (including ghosts)
    for (const roomCode of roomCodes) {
      try {
        const stateKey = REDIS_KEYS.ROOM_STATE(roomCode);
        const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);

        // Fetch room properties and player IDs simultaneously
        const [stateMap, playerIds] = await Promise.all([
          redis.hgetall(stateKey),
          redis.smembers(playersKey),
        ]);

        // If the state map is completely missing from Redis, ignore it
        if (!stateMap || Object.keys(stateMap).length === 0) {
          continue;
        }

        let isZombie = false;
        let zombieReason = 'Active';
        let connectedCount = 0;

        // Condition A: The roster list is empty in Redis
        if (!playerIds || playerIds.length === 0) {
          isZombie = true;
          zombieReason = 'Ghost Room (0 Roster Players Found)';
        } else {
          // Condition B: Roster has names, but are any of them actually connected right now?
          const pipeline = redis.pipeline();
          playerIds.forEach((id) => {
            pipeline.hget(REDIS_KEYS.PLAYER_HASH(id), 'connected');
          });
          const connectionResults = await pipeline.exec();

          if (connectionResults) {
            connectionResults.forEach((res) => {
              const connectedStatus = res[1]; // Value of 'connected' property ('true'/'false')
              if (connectedStatus === 'true') {
                connectedCount++;
              }
            });
          }

          // If nobody has a live socket footprint, it's an abandoned zombie room
          if (connectedCount === 0) {
            isZombie = true;
            zombieReason = 'Zombie Room (All Players Disconnected)';
          }
        }

        report.push({
          roomCode,
          status: stateMap.status ?? 'UNKNOWN',
          currentRound: Number(stateMap.currentRound ?? 0),
          // Show total players registered vs how many have live connections
          playerCount: playerIds ? playerIds.length : 0,
          activePrompt: stateMap.activePrompt ?? 'None',
          isZombie,
          zombieReason: isZombie
            ? `${zombieReason} [Connected: ${connectedCount}]`
            : 'Operational Active Match',
        });
      } catch (err) {
        this.logger.error(
          `Failed aggregating dashboard line for room ${roomCode}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return report;
  }
}
