import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import { validate } from 'class-validator';
import { UpdateSettingsDto } from './update-settings.dto';
import { validate } from 'class-validator';
import { UpdateSettingsDto } from './update-settings.dto';

describe('UpdateSettingsDto Validation', () => {
  it('should validate successfully with correct values', async () => {
    const dto = new UpdateSettingsDto();
    dto.timerDuration = 90;
    dto.totalRounds = 3;
    dto.theme = 'CARTOON';

    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('should fail validation with invalid timerDuration', async () => {
    const dto = new UpdateSettingsDto();
    dto.timerDuration = 45; // invalid
    dto.totalRounds = 3;
    dto.theme = 'CARTOON';

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const firstError = errors[0];
    expect(firstError).toBeDefined();
    expect(firstError?.property).toBe('timerDuration');
  });

  it('should fail validation with invalid totalRounds', async () => {
    const dto = new UpdateSettingsDto();
    dto.timerDuration = 90;
    dto.totalRounds = 2; // invalid
    dto.theme = 'CARTOON';

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const firstError = errors[0];
    expect(firstError).toBeDefined();
    expect(firstError?.property).toBe('totalRounds');
  });

  it('should fail validation with invalid theme name or lowercase theme', async () => {
    const dto = new UpdateSettingsDto();
    dto.timerDuration = 90;
    dto.totalRounds = 3;
    dto.theme = 'Cartoon'; // invalid (expects uppercase CARTOON)

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const firstError = errors[0];
    expect(firstError).toBeDefined();
    expect(firstError?.property).toBe('theme');
  });
});
