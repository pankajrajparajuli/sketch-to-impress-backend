import { IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CastVoteDto {
  @IsInt()
  @Min(1, { message: 'Stars must be at least 1.' })
  @Max(10, { message: 'You cannot cast more than 10 stars.' })
  @Type(() => Number)
  stars!: number;
}
