import { Body, Controller, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { JoinRoomDto } from './dto/join-room.dto';

@Controller('/api/v1/rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  // ── POST /api/v1/rooms/create ─────────────────────────────────────────────
  @Post('/create')
  @HttpCode(HttpStatus.CREATED)
  async createRoom() {
    return this.roomsService.createRoom();
  }

  // ── POST /api/v1/rooms/join ───────────────────────────────────────────────
  @Post('/join')
  @HttpCode(HttpStatus.OK)
  async joinRoom(@Body() dto: JoinRoomDto) {
    return this.roomsService.joinRoom(dto);
  }
}
