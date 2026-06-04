import { Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.keys';

// ─── Redis-Backed Throttler Storage ───────────────────────────────────────────
// Implements the ThrottlerStorage contract using our own RedisService.
// Keys are managed by the REDIS_KEYS matrix to satisfy Sprint 5 requirements.
// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redisService: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    const redisKey = REDIS_KEYS.THROTTLE(throttlerName, key);
    const client = this.redisService.getClient();

    // Use a pipeline to batch INCR and PTTL into a single network round-trip
    const pipeline = client.pipeline();
    pipeline.incr(redisKey);
    pipeline.pttl(redisKey);

    const results = await pipeline.exec();

    const totalHits = Number(results?.[0]?.[1] ?? 0);
    const currentTtl = Number(results?.[1]?.[1] ?? -1);

    // If the key is new or somehow lost its TTL (currentTtl < 0), apply the TTL window
    if (currentTtl < 0) {
      await client.pexpire(redisKey, ttl);
    }

    // Map remaining TTL (in ms) to seconds for the Throttler contract
    const timeToExpire =
      currentTtl > 0 ? Math.ceil(currentTtl / 1000) : Math.ceil(ttl / 1000);

    return {
      totalHits,
      timeToExpire,
      isBlocked: totalHits > limit,
      timeToBlockExpire: totalHits > limit ? timeToExpire : 0,
    };
  }
}
