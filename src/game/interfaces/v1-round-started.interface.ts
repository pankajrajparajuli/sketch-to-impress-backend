export interface V1RoundStarted {
  roomCode: string;
  round: number;
  prompt: string;
  roundEndTimestamp: number;
  serverTime: number;
}
