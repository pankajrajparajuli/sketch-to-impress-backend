import { BadRequestException } from '@nestjs/common';
import { SubmitDrawingDto } from '../dto/submit-drawing.dto';

const BLOCKED_PATTERNS = ['data:image/', 'base64', 'png', 'jpeg', 'jpg'];

export function validateVectorOnlyPayload(payload: SubmitDrawingDto): void {
  const serialized = JSON.stringify(payload).toLowerCase();

  const found = BLOCKED_PATTERNS.find((pattern) =>
    serialized.includes(pattern),
  );

  if (found) {
    throw new BadRequestException(
      'Image uploads are not allowed. Submit vector strokes only.',
    );
  }
}
