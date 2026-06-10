import { IsBoolean } from 'class-validator';

export class PlayAgainDto {
  @IsBoolean()
  confirm: boolean | undefined;
}
