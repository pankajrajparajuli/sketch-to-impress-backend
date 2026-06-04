import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import redisConfig from './common/config/redis.config';
import { RedisModule } from './redis/redis.module';
import { StiThrottlerGuard } from './common/guards/throttler.guard';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { StiThrottlerModule } from './common/throttler/throttler.module';
import { HealthController } from './health/health.controller';
import { RoomsModule } from './rooms/rooms.module';
import { GameModule } from './game/game.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [redisConfig],
    }),

    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      newListener: false,
      removeListener: false,
      maxListeners: 20,
      verboseMemoryLeak: true,
      ignoreErrors: false,
    }),

    // RedisModule must be imported before ThrottlerModule so
    // RedisThrottlerStorage can inject RedisService via DI
    RedisModule,

    StiThrottlerModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: (
        _configService: ConfigService,
        storage: RedisThrottlerStorage,
      ) => ({
        throttlers: [
          {
            name: 'global',
            ttl: 60_000,
            limit: 10,
          },
          {
            name: 'rest-join',
            ttl: 60_000,
            limit: 5,
          },
        ],
        storage,
      }),
    }),

    RoomsModule, // <-- Registered RoomsModule here
    GameModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: StiThrottlerGuard,
    },
  ],
})
export class AppModule {}
