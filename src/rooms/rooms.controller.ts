import { Body, Controller, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { JoinRoomDto } from './dto/join-room.dto';
import { CreateRoomDto } from './dto/create-room.dto';

@Controller('/api/v1/rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  // ── POST /api/v1/rooms/create ─────────────────────────────────────────────
  @Post('/create')
  @HttpCode(HttpStatus.CREATED)
  async createRoom(@Body() dto: CreateRoomDto) {
    return this.roomsService.createRoom(dto);
  }

  // ── POST /api/v1/rooms/join ───────────────────────────────────────────────
  @Post('/join')
  @HttpCode(HttpStatus.OK)
  async joinRoom(@Body() dto: JoinRoomDto) {
    return this.roomsService.joinRoom(dto);
  }
}
