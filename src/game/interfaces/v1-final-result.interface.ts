export interface FinalResultEntry {
  playerId: string;
  username: string;
  score: number;
  rank: number;
}

export interface MatchOverPayload {
  podium: FinalResultEntry[];
  standings: FinalResultEntry[];
}
