import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * Allowed charset excludes ambiguous characters:
 * 0, O, 1, I are removed to prevent user confusion.
 */
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

@Injectable()
export class CodeGenerator {
  private readonly logger = new Logger(CodeGenerator.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Generates a collision-free room code.
   * Ensures uniqueness using Redis EXISTS check.
   */
  async generateUniqueRoomCode(): Promise<string> {
    let attempt = 0;

    while (true) {
      attempt++;

      const code = this.generateCode();
      const key = this.buildRoomKey(code);

      const exists = await this.redisService.exists(key);

      if (!exists) {
        this.logger.log(
          JSON.stringify({
            event: 'ROOM_CODE_GENERATED',
            code,
            attempts: attempt,
          }),
        );

        return code;
      }

      this.logger.warn(
        JSON.stringify({
          event: 'ROOM_CODE_COLLISION',
          code,
          attempt,
        }),
      );

      // Safety guard to prevent infinite loops under extreme load
      if (attempt > 50) {
        throw new Error(
          'Failed to generate unique room code after 50 attempts',
        );
      }
    }
  }

  /**
   * Pure deterministic generator (no Redis dependency)
   */
  private generateCode(): string {
    let result = '';

    for (let i = 0; i < CODE_LENGTH; i++) {
      const idx = Math.floor(Math.random() * CHARSET.length);
      result += CHARSET[idx];
    }

    return result;
  }

  /**
   * Standardized Redis room existence key
   * Matches sprint architecture: sti:v1 namespace
   */
  private buildRoomKey(code: string): string {
    return `sti:v1:room:${code}:meta`;
  }
}
