import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsString } from 'class-validator';

export class UpdateSettingsDto {
  @Type(() => Number)
  @IsNumber()
  @IsIn([5, 60, 90, 120])
  timerDuration!: number;

  @Type(() => Number)
  @IsNumber()
  @IsIn([1, 3, 5])
  totalRounds!: number;

  @IsString()
  @IsIn(['ANIME', 'CARTOON', 'GAMING', 'RANDOM'])
  theme!: string;
}
