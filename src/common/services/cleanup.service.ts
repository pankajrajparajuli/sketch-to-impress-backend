import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class CleanupService {
  constructor(private readonly redisService: RedisService) {}

  async cleanupRoom(roomCode: string): Promise<void> {
    const redis = this.redisService.getClient();

    const keys = await redis.keys(`sti:v1:room:${roomCode}:*`);

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}
