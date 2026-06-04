import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import redisConfig from './common/config/redis.config';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    // Makes process.env variables available globally via ConfigService
    // isGlobal: true means no need to re-import ConfigModule in child modules
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      // Register the typed 'redis' namespace so any service can inject it
      load: [redisConfig],
    }),

    // Internal async event bus — decouples core game state transitions
    // wildcard: true enables namespace-style event patterns (e.g. 'game.*')
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      newListener: false,
      removeListener: false,
      maxListeners: 20,
      verboseMemoryLeak: true,
      ignoreErrors: false,
    }),
    RedisModule,
  ],
})
export class AppModule {}
