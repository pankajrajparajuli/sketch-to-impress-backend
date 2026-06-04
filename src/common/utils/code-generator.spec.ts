import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { CodeGenerator } from './code-generator';
import { RedisService } from '../../redis/redis.service';

describe('CodeGenerator (Unit)', () => {
  let codeGenerator: CodeGenerator;

  // Create a clean mock function signature
  let mockExists: ReturnType<typeof jest.fn<(key: string) => Promise<number>>>;

  beforeEach(async () => {
    mockExists = jest.fn<(key: string) => Promise<number>>();

    // ✅ FIXED: Map 'exists' directly to the service root to match code execution
    const mockRedisService = {
      exists: mockExists,
      getClient: () => ({
        exists: mockExists,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CodeGenerator,
        {
          provide: RedisService,
          useValue: mockRedisService as unknown,
        },
      ],
    }).compile();

    codeGenerator = module.get<CodeGenerator>(CodeGenerator);
  });

  // ─── CASE 1 ─────────────────────────────────────────────────────────────────
  it('should generate a string exactly 6 characters long', async () => {
    mockExists.mockResolvedValue(0);

    const code = await codeGenerator.generateUniqueRoomCode();

    expect(code).toBeDefined();
    expect(typeof code).toBe('string');
    expect(code.length).toBe(6);
  });

  // ─── CASE 2 ─────────────────────────────────────────────────────────────────
  it('should strictly contain uppercase alphanumeric characters only', async () => {
    mockExists.mockResolvedValue(0);

    const code = await codeGenerator.generateUniqueRoomCode();

    const alphanumericUppercaseRegex = /^[A-Z0-9]{6}$/;
    expect(code).toMatch(alphanumericUppercaseRegex);
  });

  // ─── CASE 3 ─────────────────────────────────────────────────────────────────
  it('should retry generation if a code collision happens in Redis', async () => {
    // First check returns 1 (taken), second check returns 0 (free)
    mockExists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const code = await codeGenerator.generateUniqueRoomCode();

    expect(code).toBeDefined();
    expect(code.length).toBe(6);

    expect(mockExists).toHaveBeenCalledTimes(2);
  });
});
