import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { RedisModule } from 'src/redis/redis.module';
import { CodeGenerator } from 'src/common/utils/code-generator';

@Module({
  imports: [RedisModule],
  controllers: [RoomsController],
  providers: [RoomsService, CodeGenerator],
})
export class RoomsModule {}
