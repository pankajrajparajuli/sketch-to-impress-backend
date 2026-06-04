import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

// ─── Redis Module ──────────────────────────────────────────────────────────────
// @Global() — registers RedisService as a singleton available to every module
// in the application without requiring explicit imports in each child module.
// This is correct here because Redis is a true application-wide infrastructure
// dependency, not a feature-scoped service.
// ──────────────────────────────────────────────────────────────────────────────

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
