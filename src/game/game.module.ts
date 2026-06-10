import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';
import { RedisModule } from '../redis/redis.module';
import { CleanupService } from '../common/services/cleanup.service';

@Module({
  imports: [RedisModule],
  providers: [GameGateway, GameService, CleanupService],
  exports: [GameService],
})
export class GameModule {}
