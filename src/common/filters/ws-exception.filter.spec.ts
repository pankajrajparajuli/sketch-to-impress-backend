import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { WsExceptionFilter } from './ws-exception.filter';
import { WsException } from '@nestjs/websockets';

describe('WsExceptionFilter', () => {
  let filter: WsExceptionFilter;

  beforeEach(() => {
    filter = new WsExceptionFilter();
  });

  it('should format error exceptions to match the unified state contract layer', () => {
    const mockSocket = {
      id: 'sock_123',
      emit: jest.fn(),
    };

    const mockHost = {
      getType: () => 'ws',
      switchToWs: () => ({
        getClient: () => mockSocket,
      }),
    } as any;

    const exception = new WsException({
      code: 'INVALID_MOVE',
      message: 'Test message',
    });
    filter.catch(exception, mockHost);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'error:exception',
      expect.objectContaining({
        success: false,
        code: 'INVALID_MOVE',
        message: 'Test message',
      }),
    );
  });

  it('should completely ignore non-websocket execution contexts', () => {
    const mockHost = {
      getType: () => 'http',
    } as any;

    expect(() => filter.catch(new WsException(''), mockHost)).not.toThrow();
  });
});
