import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service'; // 1. Import the service
import { RedisModule } from '../redis/redis.module'; // (Assuming you imported this for RedisService)

@Module({
  imports: [RedisModule],
  providers: [
    GameGateway,
    GameService, // 2. Add GameService here as a provider
  ],
  // If other modules need GameService, you can also add: exports: [GameService]
})
export class GameModule {}
