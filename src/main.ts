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

  // ── Enable CORS for frontend ──────────────────────────────────────────────
  // This allows frontend to send requests to backend
  app.enableCors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(',')
      : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  });

  // ── Global DTO validation ────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // ── Production guard ──────────────────────────────────────────────────────
  // Refuse to start if JWT_SECRET is absent or is the known placeholder value.
  // This prevents a silent security hole where tokens are signed with a public default.
  if (process.env.NODE_ENV === 'production') {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'super_secret_key_replace_before_prod' || secret === 'CHANGE_ME_GENERATE_A_64_CHAR_HEX_SECRET') {
      throw new Error(
        '[FATAL] JWT_SECRET environment variable is not set or is using the dev placeholder. ' +
        'Generate a secure secret: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"',
      );
    }
  }

  // ── Global exception filters ─────────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter(), new WsExceptionFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`[Bootstrap] sketch-to-impress-backend running on port ${port}`);
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap();
}
