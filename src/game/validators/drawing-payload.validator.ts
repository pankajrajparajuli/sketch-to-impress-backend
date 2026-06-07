import { BadRequestException } from '@nestjs/common';
import { SubmitDrawingDto } from '../dto/submit-drawing.dto';

const MAX_DRAWING_BYTES = 150 * 1024;

export function validateDrawingPayloadSize(payload: SubmitDrawingDto): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

  if (bytes > MAX_DRAWING_BYTES) {
    throw new BadRequestException('Drawing payload exceeds 150KB limit');
  }
}
