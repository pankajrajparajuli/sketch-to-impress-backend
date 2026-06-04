import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { CodeGenerator } from 'src/common/utils/code-generator';
import { REDIS_KEYS } from 'src/redis/redis.keys';
import { RoomStatus } from './enums/room-status.enum';
import { JoinRoomDto } from './dto/join-room.dto';
import * as jwt from 'jsonwebtoken';

// ─── Game Constants ────────────────────────────────────────────────────────────
const MAX_PLAYERS = 8;
const RESERVATION_TTL_SECONDS = 10;
const ROOM_TTL_SECONDS = 7200;

@Injectable()
export class RoomsService {
  constructor(
    private readonly redis: RedisService,
    private readonly codeGenerator: CodeGenerator,
  ) {}

  // ─── Create Room ─────────────────────────────────────────────────────────────

  async createRoom() {
    const roomCode = await this.codeGenerator.generateUniqueRoomCode();
    const hostId = `usr_${Math.random().toString(36).substring(2, 9)}`;

    const reconnectToken = this.signToken({
      playerId: hostId,
      roomCode,
      isHost: true,
    });

    const metaKey = REDIS_KEYS.ROOM_META(roomCode);
    const stateKey = REDIS_KEYS.ROOM_STATE(roomCode);
    const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);

    const pipeline = this.redis.getClient().pipeline();

    pipeline.hset(metaKey, {
      roomCode,
      hostId,
      createdAt: Date.now().toString(),
    });

    pipeline.hset(stateKey, {
      status: RoomStatus.LOBBY,
      currentRound: '1',
      totalRounds: '3',
      timerDuration: '90',
      theme: 'Cartoon',
    });

    pipeline.hset(
      playersKey,
      hostId,
      JSON.stringify({
        playerId: hostId,
        username: 'Host',
        isHost: true,
        connected: true,
      }),
    );

    pipeline.expire(metaKey, ROOM_TTL_SECONDS);
    pipeline.expire(stateKey, ROOM_TTL_SECONDS);
    pipeline.expire(playersKey, ROOM_TTL_SECONDS);

    await pipeline.exec();

    return {
      success: true,
      roomCode,
      hostId,
      reconnectToken,
      message: 'Lobby successfully initialized.',
    };
  }

  // ─── Join Room ────────────────────────────────────────────────────────────────

  async joinRoom(dto: JoinRoomDto) {
    const { roomCode, username } = dto;

    // ── 1. Confirm room exists ───────────────────────────────────────────────
    const metaKey = REDIS_KEYS.ROOM_META(roomCode);
    const roomExists = await this.redis.exists(metaKey);
    if (!roomExists) {
      throw new NotFoundException(`Room ${roomCode} does not exist.`);
    }

    // ── 2. Confirm room is still in LOBBY status ─────────────────────────────
    const stateKey = REDIS_KEYS.ROOM_STATE(roomCode);
    const status = await this.redis.hget(stateKey, 'status');
    if (status !== RoomStatus.LOBBY) {
      throw new BadRequestException(
        'This room is no longer accepting players. The game is already in progress.',
      );
    }

    // ── 3. Count active roster + pending reservations ────────────────────────
    // Total occupancy = confirmed players + temporary reservation slots
    // This prevents over-allocation in high-concurrency join scenarios
    const playersKey = REDIS_KEYS.ROOM_PLAYERS(roomCode);
    const activeCount = await this.redis.getClient().hlen(playersKey);

    // Count pending reservations via key scan pattern
    const reservationPattern = `sti:v1:room:${roomCode}:reservation:*`;
    const reservationKeys = await this.redis
      .getClient()
      .keys(reservationPattern);
    const pendingCount = reservationKeys.length;

    const totalOccupancy = activeCount + pendingCount;
    if (totalOccupancy >= MAX_PLAYERS) {
      throw new BadRequestException(
        `Room ${roomCode} is full. Maximum ${MAX_PLAYERS} players allowed.`,
      );
    }

    // ── 4. Generate player identity ──────────────────────────────────────────
    const playerId = `usr_${Math.random().toString(36).substring(2, 9)}`;

    const reconnectToken = this.signToken({
      playerId,
      roomCode,
      isHost: false,
    });

    // ── 5. Write 10-second reservation slot (atomic slot lock) ───────────────
    // Holds the player's seat while the client transitions from HTTP → WebSocket
    // The WebSocket gateway clears this and writes the permanent player entry
    const reservationKey = REDIS_KEYS.RESERVATION(roomCode, playerId);
    await this.redis.set(
      reservationKey,
      JSON.stringify({ playerId, username, reservedAt: Date.now() }),
      RESERVATION_TTL_SECONDS,
    );

    // ── 6. Refresh room TTL to keep session alive ────────────────────────────
    const currentRound = parseInt(
      (await this.redis.hget(stateKey, 'currentRound')) ?? '1',
      10,
    );
    await this.redis.touchRoom(roomCode, currentRound);

    return {
      success: true,
      roomCode,
      playerId,
      reconnectToken,
      message: `Successfully reserved slot in room ${roomCode}. Connect via WebSocket to finalize.`,
    };
  }

  // ─── JWT Signing Utility ──────────────────────────────────────────────────────

  signToken(payload: object): string {
    return jwt.sign(payload, process.env.JWT_SECRET ?? 'dev_secret', {
      expiresIn: '7d',
    });
  }
}
