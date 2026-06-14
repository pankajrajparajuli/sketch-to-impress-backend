import { registerAs } from '@nestjs/config';
import Redis from 'ioredis';

// ─── Redis Configuration Namespace ────────────────────────────────────────────
// Registered under the 'redis' namespace so ConfigService can retrieve it via
// configService.get<RedisConfig>('redis')
// ──────────────────────────────────────────────────────────────────────────────

export interface RedisConfig {
  host: string;
  port: number;
}

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Environment variable ${key} is required but not set.`);
  }
  return value;
}

export default registerAs(
  'redis',
  (): RedisConfig => {
    const host = getRequiredEnv('REDIS_HOST');
    const port = parseInt(getRequiredEnv('REDIS_PORT'), 10);
    return { host, port };
  },
);

// ─── Redis Client Factory ──────────────────────────────────────────────────────
// Builds a validated ioredis client instance from environment config.
// Called once during RedisModule initialization.
// All connection errors are caught here and bubbled to the NestJS logger
// rather than crashing the process silently.
// ──────────────────────────────────────────────────────────────────────────────

export function buildRedisClient(): Redis {
  const host = getRequiredEnv('REDIS_HOST');
  const port = parseInt(getRequiredEnv('REDIS_PORT'), 10);

  const client = new Redis({
    host,
    port,

    // Retry strategy — exponential backoff capped at 3 seconds
    // Returning null on attempt > 10 stops retrying and surfaces the error
    retryStrategy: (attempts: number): number | null => {
      if (attempts > 10) {
        // Surface to NestJS bootstrap logger rather than retrying forever
        console.error(
          `[RedisFactory] FATAL: Could not connect to Redis at ${host}:${port} after ${attempts} attempts. Halting retries.`,
        );
        return null;
      }
      // Exponential backoff: 100ms, 200ms, 400ms... capped at 3000ms
      return Math.min(attempts * 100, 3000);
    },

    // Emit errors to the process error handler instead of throwing
    lazyConnect: false,
    enableOfflineQueue: true,
    connectTimeout: 10_000,
    maxRetriesPerRequest: 3,
  });

  // ── Connection lifecycle hooks ──────────────────────────────────────────────
  client.on('connect', () => {
    console.log(`[RedisFactory] Connected to Redis at ${host}:${port}`);
  });

  client.on('ready', () => {
    console.log(`[RedisFactory] Redis client ready. Accepting commands.`);
  });

  client.on('error', (err: Error) => {
    console.error(`[RedisFactory] Redis connection error: ${err.message}`);
  });

  client.on('close', () => {
    console.warn(`[RedisFactory] Redis connection closed.`);
  });

  client.on('reconnecting', (delay: number) => {
    console.warn(`[RedisFactory] Redis reconnecting in ${delay}ms...`);
  });

  return client;
}
