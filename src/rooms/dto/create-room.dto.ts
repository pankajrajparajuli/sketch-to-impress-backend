import { IsString, Length, Matches } from 'class-validator';

export class CreateRoomDto {
  @IsString()
  @Length(1, 15, { message: 'username must be between 1 and 15 characters.' })
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'username must contain only letters, numbers, or underscores.',
  })
  username!: string;
}
