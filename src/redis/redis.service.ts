import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { buildRedisClient } from '../common/config/redis.config';
import { REDIS_KEYS } from './redis.keys';

// ─── Redis Service ─────────────────────────────────────────────────────────────
// Single injectable wrapper around the ioredis client.
// All game modules interact with Redis exclusively through this service.
// Direct ioredis calls outside this service are not permitted.
// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    // buildRedisClient() fires here — this is where the Redis connection
    // lifecycle hooks (connect, ready, error) trigger for the first time
    this.client = buildRedisClient();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis client disconnected gracefully on module destroy.');
  }

  // ── Raw Client Access ──────────────────────────────────────────────────────
  // Exposed for pipeline construction in game.service.ts and cleanup.service.ts

  getClient(): Redis {
    return this.client;
  }

  // ── TTL Refresh ────────────────────────────────────────────────────────────

  /**
   * touchRoom — refreshes the 2-hour TTL on all active keys for a room.
   * Must be called after every meaningful state mutation to prevent
   * silent key expiration mid-game on the M4 host mac "pinocchio".
   */
  async touchRoom(roomCode: string, currentRound: number): Promise<void> {
    const TTL = 7200; // 2 hours in seconds
    const pipeline = this.client.pipeline();

    pipeline.expire(REDIS_KEYS.ROOM_META(roomCode), TTL);
    pipeline.expire(REDIS_KEYS.ROOM_PLAYERS(roomCode), TTL);
    pipeline.expire(REDIS_KEYS.ROOM_STATE(roomCode), TTL);
    pipeline.expire(REDIS_KEYS.LEADERBOARD(roomCode), TTL);
    pipeline.expire(REDIS_KEYS.USED_PROMPTS(roomCode), TTL);
    pipeline.expire(REDIS_KEYS.ROUND_STATE(roomCode, currentRound), TTL);
    pipeline.expire(REDIS_KEYS.ROUND_SUBMITTED(roomCode, currentRound), TTL);
    pipeline.expire(REDIS_KEYS.ROUND_DRAWINGS(roomCode, currentRound), TTL);

    await pipeline.exec();
    this.logger.log(`[touchRoom] TTL refreshed for room ${roomCode}`);
  }

  // ── Hash Operations ────────────────────────────────────────────────────────

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    await this.client.hdel(key, ...fields);
  }

  async hincrby(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    return this.client.hincrby(key, field, increment);
  }

  // ── Set Operations ─────────────────────────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<void> {
    await this.client.sadd(key, ...members);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const result = await this.client.sismember(key, member);
    return result === 1;
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async scard(key: string): Promise<number> {
    return this.client.scard(key);
  }

  // ── String / Lock Operations ───────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  /**
   * setnx — atomic "set if not exists" for lock acquisition.
   * Returns true if the lock was acquired, false if already held.
   */
  async setnx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async del(...keys: string[]): Promise<void> {
    await this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }
}
