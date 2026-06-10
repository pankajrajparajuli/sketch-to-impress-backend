import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { CleanupService } from './cleanup.service';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.keys';

describe('CleanupService', () => {
  let service: CleanupService;
  let mockDel: ReturnType<typeof jest.fn>;
  let mockExec: ReturnType<typeof jest.fn>;

  beforeEach(async () => {
    mockDel = jest.fn().mockReturnValue({ del: mockDel });
    mockExec = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);

    const mockPipeline = {
      del: mockDel,
      exec: mockExec,
    };

    const mockRedisService = {
      getClient: () => ({
        pipeline: () => mockPipeline,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CleanupService,
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get(CleanupService);
  });

  describe('cleanupRoundStrokes', () => {
    it('should delete stroke keys for every roster player in a single pipeline', async () => {
      await service.cleanupRoundStrokes('ROOM1', 2, ['p1', 'p2']);

      expect(mockDel).toHaveBeenCalledWith(
        'sti:v1:room:ROOM1:round:2:player:p1',
      );
      expect(mockDel).toHaveBeenCalledWith(
        'sti:v1:room:ROOM1:round:2:player:p2',
      );
      expect(mockExec).toHaveBeenCalled();
    });
  });

  describe('cleanupMatch', () => {
    it('should purge round artifacts and core room keys on match termination', async () => {
      await service.cleanupMatch('ROOM9', 2, ['p1']);

      expect(mockDel).toHaveBeenCalledWith(
        REDIS_KEYS.GALLERY_INDEX('ROOM9', 1),
      );
      expect(mockDel).toHaveBeenCalledWith(
        REDIS_KEYS.GALLERY_ORDER('ROOM9', 2),
      );
      expect(mockDel).toHaveBeenCalledWith(REDIS_KEYS.ROOM_META('ROOM9'));
      expect(mockDel).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('p1'));
      expect(mockExec).toHaveBeenCalled();
    });
  });
});
