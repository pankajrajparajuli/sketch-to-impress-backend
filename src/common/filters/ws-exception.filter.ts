import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

// Now strictly scoped to WsException only — HttpExceptionFilter handles HTTP
@Catch(WsException)
export class WsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  catch(exception: WsException, host: ArgumentsHost): void {
    // Guard: only process WebSocket context — skip HTTP contexts entirely
    if (host.getType() !== 'ws') return;

    const client = host.switchToWs().getClient<Socket>();

    let message = 'An unexpected WebSocket error occurred.';
    let code = 'WS_INTERNAL_ERROR';

    const error = exception.getError();
    if (typeof error === 'string') {
      message = error;
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error
    ) {
      message = (error as { message: string }).message;
      if ('code' in error) {
        code = (error as { code: string }).code;
      }
    }

    const errorPayload = {
      success: false,
      code,
      timestamp: new Date().toISOString(),
      message,
    };

    this.logger.error(
      JSON.stringify({
        event: 'ws_exception',
        socketId: client.id,
        code,
        message,
      }),
    );

    client.emit('error:exception', errorPayload);
  }
}
