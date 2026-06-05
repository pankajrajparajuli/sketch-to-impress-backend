import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { WsExceptionFilter } from './common/filters/ws-exception.filter';

export async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const app = await NestFactory.create(AppModule);

  // ── Global DTO validation ────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // ── Global exception filters ─────────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter(), new WsExceptionFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`[Bootstrap] sketch-to-impress-backend running on port 3000`);
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap();
}
