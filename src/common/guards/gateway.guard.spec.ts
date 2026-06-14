import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ExecutionContext } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { GatewayGuard } from './gateway.guard';
import { RedisService } from '../../redis/redis.service';

describe('GatewayGuard', () => {
  let guard: GatewayGuard;
  let mockRedisClient: any;
  let mockRedisService: any;

  beforeEach(() => {
    mockRedisClient = {
      hgetall: jest.fn<() => Promise<Record<string, string>>>(),
    };
    mockRedisService = {
      getClient: () => mockRedisClient,
    };
    guard = new GatewayGuard(mockRedisService as RedisService);
  });

  const createMockContext = (clientData: any): ExecutionContext => {
    const mockSocket = {
      data: clientData,
    };
    return {
      switchToWs: () => ({
        getClient: () => mockSocket,
      }),
    } as unknown as ExecutionContext;
  };

  it('should return true if client playerId matches room hostId', async () => {
    const context = createMockContext({
      roomCode: 'ABCDEF',
      playerId: 'usr_123',
    });
    mockRedisClient.hgetall.mockResolvedValue({ hostId: 'usr_123' });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('should throw WsException if client playerId does not match room hostId', async () => {
    const context = createMockContext({
      roomCode: 'ABCDEF',
      playerId: 'usr_456',
    });
    mockRedisClient.hgetall.mockResolvedValue({ hostId: 'usr_123' });

    await expect(guard.canActivate(context)).rejects.toThrow(WsException);
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Only host can perform this action',
    );
  });

  it('should throw WsException if client data is missing', async () => {
    const context = createMockContext(undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(WsException);
  });
});
