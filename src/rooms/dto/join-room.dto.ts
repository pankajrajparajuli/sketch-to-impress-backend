import { IsString, Length, Matches } from 'class-validator';

export class JoinRoomDto {
  @IsString()
  @Length(6, 6, { message: 'roomCode must be exactly 6 characters.' })
  @Matches(/^[A-Z2-9]{6}$/, {
    message: 'roomCode must be uppercase alphanumeric, excluding 0, O, 1, I.',
  })
  roomCode!: string;

  @IsString()
  @Length(1, 15, { message: 'username must be between 1 and 15 characters.' })
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'username must contain only letters, numbers, or underscores.',
  })
  username!: string;
}
