import { RoomStatus } from '../../rooms/enums/room-status.enum';

// ─── Reconnect State Snapshot ──────────────────────────────────────────────────
// Full context snapshot sent to a reconnecting client via v1:player:reconnected.
// Contains everything the frontend needs to restore its exact UI state.
// ──────────────────────────────────────────────────────────────────────────────

export interface V1ReconnectState {
  roomCode: string;
  playerId: string;
  phase: RoomStatus;
  currentRound: number;
  totalRounds: number;
  timerDuration: number;
  theme: string;
  remainingTime: number; // Seconds remaining in the current phase clock
  activePrompt: string | null; // Null if in LOBBY phase
  leaderboard: LeaderboardEntry[];
  players: RosterPlayer[];
}

export interface LeaderboardEntry {
  playerId: string;
  username: string;
  stars: number;
}

export interface RosterPlayer {
  playerId: string;
  username: string;
  isHost: boolean;
  connected: boolean;
}
