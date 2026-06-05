import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock the ioredis module before importing RedisService
const mockMulti = {
  hset: jest.fn<any>().mockReturnThis(),
  exec: jest.fn<any>().mockResolvedValue([]),
};

const mockPipeline = {
  expire: jest.fn<any>().mockReturnThis(),
  exec: jest.fn<any>().mockResolvedValue([]),
};

const mockRedisClient = {
  quit: jest.fn<any>().mockResolvedValue(undefined),
  hset: jest.fn<any>().mockResolvedValue(1),
  hget: jest.fn<any>().mockResolvedValue('value'),
  hgetall: jest.fn<any>().mockResolvedValue({ field: 'value' }),
  hdel: jest.fn<any>().mockResolvedValue(1),
  hincrby: jest.fn<any>().mockResolvedValue(5),
  sadd: jest.fn<any>().mockResolvedValue(1),
  sismember: jest.fn<any>().mockResolvedValue(1),
  smembers: jest.fn<any>().mockResolvedValue(['member1']),
  scard: jest.fn<any>().mockResolvedValue(1),
  get: jest.fn<any>().mockResolvedValue('value'),
  set: jest.fn<any>().mockResolvedValue('OK'),
  del: jest.fn<any>().mockResolvedValue(1),
  exists: jest.fn<any>().mockResolvedValue(1),
  expire: jest.fn<any>().mockResolvedValue(1),
  multi: jest.fn<any>().mockReturnValue(mockMulti),
  pipeline: jest.fn<any>().mockReturnValue(mockPipeline),
  on: jest.fn<any>(),
};

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn<any>().mockImplementation(() => mockRedisClient),
  };
});

import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from './redis.service';

describe('RedisService', () => {
  let service: RedisService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [RedisService],
    }).compile();

    service = module.get<RedisService>(RedisService);
  });

  it('should quit client on onModuleDestroy', async () => {
    await service.onModuleDestroy();
    expect(mockRedisClient.quit).toHaveBeenCalled();
  });

  it('should return client via getClient', () => {
    expect(service.getClient()).toBe(mockRedisClient);
  });

  it('should save player presence atomically', async () => {
    await service.savePlayerPresence('room123', {
      playerId: 'usr_1',
      username: 'Bob',
      isHost: true,
      connected: true,
    });

    expect(mockRedisClient.multi).toHaveBeenCalled();
    expect(mockMulti.hset).toHaveBeenCalledTimes(2);
    expect(mockMulti.exec).toHaveBeenCalled();
  });

  it('should touch room and refresh TTLs', async () => {
    await service.touchRoom('room123', 2);
    expect(mockRedisClient.pipeline).toHaveBeenCalled();
    expect(mockPipeline.expire).toHaveBeenCalledTimes(8);
    expect(mockPipeline.exec).toHaveBeenCalled();
  });

  it('should perform hset, hget, hgetall, hdel, hincrby operations', async () => {
    await service.hset('key', 'field', 'value');
    expect(mockRedisClient.hset).toHaveBeenCalledWith('key', 'field', 'value');

    const hgetVal = await service.hget('key', 'field');
    expect(hgetVal).toBe('value');
    expect(mockRedisClient.hget).toHaveBeenCalledWith('key', 'field');

    const hgetallVal = await service.hgetall('key');
    expect(hgetallVal).toEqual({ field: 'value' });
    expect(mockRedisClient.hgetall).toHaveBeenCalledWith('key');

    await service.hdel('key', 'field');
    expect(mockRedisClient.hdel).toHaveBeenCalledWith('key', 'field');

    const hincrbyVal = await service.hincrby('key', 'field', 2);
    expect(hincrbyVal).toBe(5);
    expect(mockRedisClient.hincrby).toHaveBeenCalledWith('key', 'field', 2);
  });

  it('should perform sadd, sismember, smembers, scard operations', async () => {
    await service.sadd('key', 'member1');
    expect(mockRedisClient.sadd).toHaveBeenCalledWith('key', 'member1');

    const sismemberVal = await service.sismember('key', 'member1');
    expect(sismemberVal).toBe(true);
    expect(mockRedisClient.sismember).toHaveBeenCalledWith('key', 'member1');

    const smembersVal = await service.smembers('key');
    expect(smembersVal).toEqual(['member1']);
    expect(mockRedisClient.smembers).toHaveBeenCalledWith('key');

    const scardVal = await service.scard('key');
    expect(scardVal).toBe(1);
    expect(mockRedisClient.scard).toHaveBeenCalledWith('key');
  });

  it('should perform get, set, setnx, del, exists, expire operations', async () => {
    const getVal = await service.get('key');
    expect(getVal).toBe('value');
    expect(mockRedisClient.get).toHaveBeenCalledWith('key');

    await service.set('key', 'value');
    expect(mockRedisClient.set).toHaveBeenCalledWith('key', 'value');

    await service.set('key', 'value', 60);
    expect(mockRedisClient.set).toHaveBeenCalledWith('key', 'value', 'EX', 60);

    mockRedisClient.set.mockResolvedValueOnce('OK');
    const setnxVal = await service.setnx('key', 'value', 60);
    expect(setnxVal).toBe(true);
    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'key',
      'value',
      'EX',
      60,
      'NX',
    );

    await service.del('key');
    expect(mockRedisClient.del).toHaveBeenCalledWith('key');

    const existsVal = await service.exists('key');
    expect(existsVal).toBe(true);
    expect(mockRedisClient.exists).toHaveBeenCalledWith('key');

    await service.expire('key', 60);
    expect(mockRedisClient.expire).toHaveBeenCalledWith('key', 60);
  });
});
