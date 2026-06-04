import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// Now strictly scoped to HttpException only — WsExceptionFilter handles the rest
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost): void {
    // Guard: only process HTTP context — skip WebSocket contexts entirely
    if (host.getType() !== 'http') return;

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception.getStatus();

    let message: string | string[] = 'Internal server error';
    const responseBody = exception.getResponse();

    if (typeof responseBody === 'string') {
      message = responseBody;
    } else if (
      typeof responseBody === 'object' &&
      responseBody !== null &&
      'message' in responseBody
    ) {
      message = (responseBody as { message: string | string[] }).message;
    }

    const errorPayload = {
      success: false,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message,
    };

    this.logger.error(
      JSON.stringify({
        event: 'http_exception',
        statusCode: status,
        path: request.url,
        method: request.method,
        message,
      }),
    );

    response.status(status).json(errorPayload);
  }
}
