import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module'; // Make sure this path points to your RedisModule
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminDashboardController } from './admin-dashboard.controller';

@Module({
  imports: [RedisModule], // Imports RedisModule so AdminDashboardService can access the Redis client
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService],
})
export class AdminModule {}
