import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { WsExceptionFilter } from './common/filters/ws-exception.filter';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Global DTO validation pipe — enforces class-validator decorators
  // whitelist: strips any unknown properties not declared in the DTO
  // transform: auto-converts plain JSON objects into typed DTO class instances
  // forbidNonWhitelisted: hard-rejects requests carrying undeclared fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  // ── Global exception filters ─────────────────────────────────────────────
  // HttpExceptionFilter: catches all REST pipeline exceptions
  // WsExceptionFilter:   catches all WebSocket gateway exceptions
  // Order matters — HTTP filter registered first as the outermost catch-all
  app.useGlobalFilters(new HttpExceptionFilter(), new WsExceptionFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`[Bootstrap] sketch-to-impress-backend running on port ${port}`);
}

bootstrap();
