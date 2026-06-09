import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { RedisService } from '../../redis/redis.service';
import { StiThrottlerGuard } from '../guards/throttler.guard';
import { ThrottlerException } from '@nestjs/throttler';
import { StiThrottlerModule } from './throttler.module';

describe('Throttler Components', () => {
  let storage: RedisThrottlerStorage;
  let redisService: RedisService;

  let mockIncr: ReturnType<typeof jest.fn<any>>;
  let mockPttl: ReturnType<typeof jest.fn<any>>;
  let mockPexpire: ReturnType<typeof jest.fn<any>>;
  let mockExec: ReturnType<typeof jest.fn<any>>;

  beforeEach(async () => {
    mockIncr = jest.fn<any>().mockReturnThis();
    mockPttl = jest.fn<any>().mockReturnThis();
    mockPexpire = jest.fn<any>().mockResolvedValue(1);
    mockExec = jest.fn<any>();

    const mockPipeline = {
      incr: mockIncr,
      pttl: mockPttl,
      exec: mockExec,
    };

    const mockRedisClient = {
      pipeline: () => mockPipeline,
      pexpire: mockPexpire,
    };

    const mockRedisService = {
      getClient: () => mockRedisClient,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisThrottlerStorage,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    storage = module.get<RedisThrottlerStorage>(RedisThrottlerStorage);
    redisService = module.get<RedisService>(RedisService);
  });

  describe('RedisThrottlerStorage', () => {
    it('should increment throttle hits and return remaining ttl when key is already initialized', async () => {
      mockExec.mockResolvedValue([
        [null, 5], // 5 hits
        [null, 2500], // 2500ms remaining
      ]);

      const result = await storage.increment(
        'ip_1.2.3.4',
        5000,
        10,
        0,
        'limit_check',
      );

      expect(mockIncr).toHaveBeenCalled();
      expect(mockPttl).toHaveBeenCalled();
      expect(mockPexpire).not.toHaveBeenCalled();
      expect(result).toEqual({
        totalHits: 5,
        timeToExpire: 3, // Math.ceil(2500 / 1000)
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it('should apply pexpire when pttl returns less than 0 (new key)', async () => {
      mockExec.mockResolvedValue([
        [null, 1], // 1 hit
        [null, -2], // TTL not set/expired
      ]);

      const result = await storage.increment(
        'ip_1.2.3.4',
        5000,
        10,
        0,
        'limit_check',
      );

      expect(mockPexpire).toHaveBeenCalledWith(
        'sti:v1:throttle:limit_check:ip_1.2.3.4',
        5000,
      );
      expect(result).toEqual({
        totalHits: 1,
        timeToExpire: 5, // Math.ceil(5000 / 1000)
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it('should return isBlocked true and correct block expire time when limit exceeded', async () => {
      mockExec.mockResolvedValue([
        [null, 11], // 11 hits (limit is 10)
        [null, 4200], // 4.2 seconds remaining
      ]);

      const result = await storage.increment(
        'ip_1.2.3.4',
        5000,
        10,
        0,
        'limit_check',
      );

      expect(result).toEqual({
        totalHits: 11,
        timeToExpire: 5, // Math.ceil(4200 / 1000)
        isBlocked: true,
        timeToBlockExpire: 5,
      });
    });
  });

  describe('StiThrottlerGuard', () => {
    it('should throw ThrottlerException on throwThrottlingException', async () => {
      const guard = new StiThrottlerGuard({} as any, {} as any, {} as any);

      await expect(async () => {
        await (guard as any).throwThrottlingException();
      }).rejects.toThrow(ThrottlerException);
    });
  });

  describe('StiThrottlerModule', () => {
    it('should compile StiThrottlerModule correctly', async () => {
      const mockRedisService = { getClient: jest.fn() };
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [StiThrottlerModule],
      })
        .overrideProvider(RedisService)
        .useValue(mockRedisService)
        .compile();

      const module = moduleFixture.get<StiThrottlerModule>(StiThrottlerModule);
      expect(module).toBeDefined();
    });
  });
});
