import { IsIn, IsString } from 'class-validator';

export class UpdateSettingsDto {
  @IsIn([60, 90, 120])
  timerDuration!: number;

  @IsIn([1, 3, 5])
  totalRounds!: number;

  @IsString()
  @IsIn(['ANIME', 'CARTOON', 'GAMING', 'RANDOM'])
  theme!: string;
}
