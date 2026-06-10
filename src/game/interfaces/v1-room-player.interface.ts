export interface RoomPlayer {
  playerId: string;
  username: string;
  isHost: boolean;
  connected: boolean;
  /** Present only for the active room host — mirrors ROOM_META.hostId */
  hostId?: string;
}
