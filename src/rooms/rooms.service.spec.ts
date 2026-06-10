import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { RoomsService } from './rooms.service';
import { RedisService } from '../redis/redis.service'; // ✅ Using absolute-insulated pathing
import { CodeGenerator } from '../common/utils/code-generator';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { RoomStatus } from './enums/room-status.enum';

describe('RoomsService (Unit)', () => {
  let roomsService: RoomsService;

  // Trackable spy components
  let mockExists: ReturnType<typeof jest.fn<(key: string) => Promise<number>>>;
  let mockHget: ReturnType<
    typeof jest.fn<(key: string, field: string) => Promise<string | null>>
  >;
  let mockHgetall: ReturnType<
    typeof jest.fn<(key: string) => Promise<Record<string, string>>>
  >;
  let mockScard: ReturnType<typeof jest.fn<(key: string) => Promise<number>>>;
  let mockKeys: ReturnType<
    typeof jest.fn<(pattern: string) => Promise<string[]>>
  >;
  let mockSetex: ReturnType<typeof jest.fn>;
  let mockHset: ReturnType<typeof jest.fn>;
  let mockExpire: ReturnType<typeof jest.fn>;
  let mockExec: ReturnType<typeof jest.fn>;

  beforeEach(async () => {
    mockExists = jest.fn<(key: string) => Promise<number>>();
    mockHget =
      jest.fn<(key: string, field: string) => Promise<string | null>>();
    mockHgetall =
      jest.fn<(key: string) => Promise<Record<string, string>>>();
    mockScard = jest.fn<(key: string) => Promise<number>>();
    mockKeys = jest.fn<(pattern: string) => Promise<string[]>>();
    mockSetex = jest.fn();
    mockHset = jest.fn();
    mockExpire = jest.fn();
    mockExec = jest.fn();

    // Deep object mock for Redis Pipeline chains
    const mockPipeline = {
      hset: mockHset,
      setex: mockSetex,
      expire: mockExpire,
      exec: mockExec.mockResolvedValue([]),
    };

    const mockRedisService = {
      exists: mockExists,
      hget: mockHget,
      hgetall: mockHgetall,
      touchRoom: jest.fn<() => Promise<void>>().mockResolvedValue(),
      getClient: () => ({
        scard: mockScard,
        keys: mockKeys,
        setex: mockSetex,
        pipeline: () => mockPipeline,
      }),
    };

    const mockCodeGenerator = {
      generateUniqueRoomCode: jest
        .fn<() => Promise<string>>()
        .mockResolvedValue('MBCVGY'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomsService,
        { provide: RedisService, useValue: mockRedisService as unknown },
        { provide: CodeGenerator, useValue: mockCodeGenerator },
      ],
    }).compile();

    roomsService = module.get<RoomsService>(RoomsService);
  });

  // ─── CASE 4: CREATE ROOM SUCCESS ──────────────────────────────────────────
  it('should successfully initialize a room and seed host reservation', async () => {
    const dto = { username: 'HostUser' };
    const result = await roomsService.createRoom(dto);

    expect(result.success).toBe(true);
    expect(result.roomCode).toBe('MBCVGY');
    expect(result.playerId).toBe(result.hostId);
    expect(result.hostId).toBeDefined();
    expect(result.username).toBe('HostUser');
    expect(result.reconnectToken).toBeDefined();

    expect(mockHset).toHaveBeenCalledTimes(2); // ROOM_META and ROOM_STATE
    expect(mockSetex).toHaveBeenCalledTimes(1); // Host 10s reservation
    expect(mockExpire).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  // ─── CASE 5: JOIN ROOM SUCCESS ────────────────────────────────────────────
  it('should allow a player to reserve a slot if room is valid and not full', async () => {
    mockExists.mockResolvedValue(1);
    mockHgetall.mockResolvedValue({ hostId: 'usr_host1' });
    mockHget.mockResolvedValue(RoomStatus.LOBBY);
    mockScard.mockResolvedValue(2);
    mockKeys.mockResolvedValue(['res1', 'res2']);

    const dto = { roomCode: 'MBCVGY', username: 'DoodleBob' };
    const result = await roomsService.joinRoom(dto);

    expect(result.success).toBe(true);
    expect(result.playerId).toBeDefined();
    expect(result.username).toBe('DoodleBob');
    expect(result.hostId).toBe('usr_host1');
    expect(result.reconnectToken).toBeDefined();
    expect(mockSetex).toHaveBeenCalledTimes(1);
  });

  // ─── CASE 6: JOIN ROOM 404 NOT FOUND ──────────────────────────────────────
  it('should throw NotFoundException if room code does not exist in cache', async () => {
    mockExists.mockResolvedValue(0);

    const dto = { roomCode: 'FAKE66', username: 'DoodleBob' };
    await expect(roomsService.joinRoom(dto)).rejects.toThrow(NotFoundException);
  });

  // ─── CASE 7: JOIN ROOM 400 INVALID STATE ──────────────────────────────────
  it('should throw BadRequestException if game status has moved past LOBBY', async () => {
    mockExists.mockResolvedValue(1);
    mockHget.mockResolvedValue('STUDIO');

    const dto = { roomCode: 'MBCVGY', username: 'DoodleBob' };
    await expect(roomsService.joinRoom(dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  // ─── CASE 8: JOIN ROOM 400 CAPACITY LIMIT ──────────────────────────────────
  it('should throw BadRequestException if active + pending slots reach MAX_PLAYERS', async () => {
    mockExists.mockResolvedValue(1);
    mockHget.mockResolvedValue(RoomStatus.LOBBY);
    mockScard.mockResolvedValue(6);
    mockKeys.mockResolvedValue(['r1', 'r2']);

    const dto = { roomCode: 'MBCVGY', username: 'DoodleBob' };
    await expect(roomsService.joinRoom(dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  // ─── CASE 9: TOKEN VALIDITY CHECKS ─────────────────────────────────────────
  it('should generate a token containing valid claims during room initialization', async () => {
    const result = await roomsService.createRoom({ username: 'HostUser' });

    const token = result.reconnectToken;
    expect(typeof token).toBe('string');

    const tokenParts = token.split('.');
    expect(tokenParts.length).toBe(3);
  });
});
