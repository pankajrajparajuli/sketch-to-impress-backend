import { Controller, Get } from '@nestjs/common';
// eslint-disable-next-line prettier/prettier
import { AdminDashboardService, ActiveRoomDashboardRow } from './admin-dashboard.service';

@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly adminService: AdminDashboardService) {}

  @Get('rooms')
  async getActiveRooms(): Promise<{
    success: boolean;
    data: ActiveRoomDashboardRow[];
  }> {
    const activeRoomsReport = await this.adminService.getLiveRoomsReport();
    return {
      success: true,
      data: activeRoomsReport,
    };
  }
}
