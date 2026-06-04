import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';

// ─── Custom Throttler Guard ────────────────────────────────────────────────────
// Extends the base ThrottlerGuard to return a structured 429 payload
// matching the same schema as HttpExceptionFilter.
// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class StiThrottlerGuard extends ThrottlerGuard {
  protected throwThrottlingException(): Promise<void> {
    throw new ThrottlerException(
      'Too many requests. Slow down and try again shortly.',
    );
  }
}
