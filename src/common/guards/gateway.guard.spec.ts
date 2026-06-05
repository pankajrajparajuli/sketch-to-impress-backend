import { describe, it, expect, jest } from '@jest/globals';
import { ExecutionContext } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { GatewayGuard } from './gateway.guard';

describe('GatewayGuard', () => {
  const guard = new GatewayGuard();

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

  it('should return true if client isHost is true', () => {
    const context = createMockContext({
      isHost: true,
      roomCode: 'ABCDEF',
      playerId: 'usr_123',
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw WsException if client isHost is false', () => {
    const context = createMockContext({
      isHost: false,
      roomCode: 'ABCDEF',
      playerId: 'usr_123',
    });
    expect(() => guard.canActivate(context)).toThrow(WsException);
    expect(() => guard.canActivate(context)).toThrow(
      'Only host can perform this action',
    );
  });

  it('should throw WsException if client data is missing', () => {
    const context = createMockContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(WsException);
  });
});
