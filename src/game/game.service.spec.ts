import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { GameService } from './game.service';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';

describe('GameService', () => {
  let service: GameService;

  let mockHset: ReturnType<typeof jest.fn>;
  let mockSadd: ReturnType<typeof jest.fn>;
  let mockSmembers: ReturnType<typeof jest.fn>;
  let mockHgetall: ReturnType<typeof jest.fn>;
  let mockExec: ReturnType<typeof jest.fn>;

  beforeEach(async () => {
    mockHset = jest.fn();
    mockSadd = jest.fn();
    mockSmembers = jest.fn();
    mockHgetall = jest.fn();
    mockExec = jest.fn();

    const mockPipeline = {
      sadd: mockSadd,
      hset: mockHset,
      hgetall: mockHgetall,
      exec: mockExec,
    };

    const mockRedisService = {
      getClient: () => ({
        hset: mockHset,
        smembers: mockSmembers,
        pipeline: () => mockPipeline,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<GameService>(GameService);
  });

  describe('updateRoomSettings', () => {
    it('should update room settings inside the ROOM_STATE hash map', async () => {
      mockHset.mockResolvedValue('OK');
      const roomCode = 'ABCDEF';
      const settings = {
        timerDuration: 90,
        totalRounds: 3,
        theme: 'CARTOON',
      };

      await service.updateRoomSettings(roomCode, settings);

      expect(mockHset).toHaveBeenCalledWith(REDIS_KEYS.ROOM_STATE(roomCode), {
        timerDuration: '90',
        totalRounds: '3',
        theme: 'CARTOON',
      });
    });
  });

  describe('addPlayerToRoster', () => {
    it('should add playerId to ROOM_PLAYERS set and write connection details to PLAYER_HASH', async () => {
      mockExec.mockResolvedValue([
        [null, 1],
        [null, 'OK'],
      ]);

      const roomCode = 'ABCDEF';
      const playerId = 'usr_123';
      const username = 'PixelMaster';
      const isHost = true;

      await service.addPlayerToRoster(roomCode, playerId, username, isHost);

      expect(mockSadd).toHaveBeenCalledWith(
        REDIS_KEYS.ROOM_PLAYERS(roomCode),
        playerId,
      );
      expect(mockHset).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH(playerId), {
        playerId,
        username,
        isHost: 'true',
        connected: 'true',
      });
      expect(mockExec).toHaveBeenCalled();
    });
  });

  describe('getRoomRoster', () => {
    it('should return empty array if no playerIds are in room', async () => {
      mockSmembers.mockResolvedValue([]);

      const result = await service.getRoomRoster('ABCDEF');

      expect(result).toEqual([]);
      expect(mockSmembers).toHaveBeenCalledWith(
        REDIS_KEYS.ROOM_PLAYERS('ABCDEF'),
      );
    });

    it('should call hgetall for each playerId in pipeline and return list of player objects', async () => {
      const roomCode = 'ABCDEF';
      mockSmembers.mockResolvedValue(['usr_1', 'usr_2']);

      mockExec.mockResolvedValue([
        [
          null,
          {
            playerId: 'usr_1',
            username: 'Bob',
            isHost: 'true',
            connected: 'true',
          },
        ],
        [
          null,
          {
            playerId: 'usr_2',
            username: 'Alice',
            isHost: 'false',
            connected: 'false',
          },
        ],
      ]);

      const result = await service.getRoomRoster(roomCode);

      expect(mockHgetall).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('usr_1'));
      expect(mockHgetall).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('usr_2'));
      expect(mockExec).toHaveBeenCalled();

      expect(result).toEqual([
        {
          playerId: 'usr_1',
          username: 'Bob',
          isHost: true,
          connected: true,
        },
        {
          playerId: 'usr_2',
          username: 'Alice',
          isHost: false,
          connected: false,
        },
      ]);
    });
  });
});
