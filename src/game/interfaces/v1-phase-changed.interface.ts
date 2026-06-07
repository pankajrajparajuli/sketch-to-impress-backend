import { RoomStatus } from '../../rooms/enums/room-status.enum';

export interface V1PhaseChanged {
  roomCode: string;
  status: RoomStatus;
}
