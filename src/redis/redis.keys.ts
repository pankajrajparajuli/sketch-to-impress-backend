// ─── STI Redis Key Schema Matrix ──────────────────────────────────────────────
// ALL Redis key construction must go through this factory exclusively.
// No raw string keys are permitted anywhere else in the codebase.
// Prefix: sti:v1: — versioned for future migration compatibility.
// ──────────────────────────────────────────────────────────────────────────────

export const REDIS_KEYS = {
  // ── Infrastructure Keys ──────────────────────────────────────────────────────

  /** Throttler & rate-limiting tracking key */
  THROTTLE: (throttlerName: string, key: string): string =>
    `sti:v1:throttle:${throttlerName}:${key}`,

  // ── Room-Level Keys ──────────────────────────────────────────────────────────

  /** Core room metadata hash: status, timerDuration, totalRounds, theme, hostId */
  ROOM_META: (roomCode: string): string => `sti:v1:room:${roomCode}:meta`,

  /** Active player roster set — stores serialized player JSON blobs */
  ROOM_PLAYERS: (roomCode: string): string => `sti:v1:room:${roomCode}:players`,

  /** Room phase state hash: currentRound, phase, roundStartTimestamp, roundEndTimestamp */
  ROOM_STATE: (roomCode: string): string => `sti:v1:room:${roomCode}:state`,

  /** Countdown tracking key for managing headless windows during host migrations */
  HOST_MIGRATION_TIMER: (roomCode: string): string =>
    `sti:v1:room:${roomCode}:host-migration`,

  /** SETNX game-start lock — prevents duplicate match initializations */
  GAME_START_LOCK: (roomCode: string): string =>
    `sti:v1:room:${roomCode}:game-start-lock`,

  /** SETNX round transition lock — prevents concurrent phase switches */
  TRANSITION_LOCK: (roomCode: string): string =>
    `sti:v1:room:${roomCode}:round-transition-lock`,

  /** Prompt history reference array map for the active room session */
  PROMPT_HISTORY: (roomCode: string): string =>
    `sti:v1:room:${roomCode}:prompt-history`,

  // ── Round-Level Keys ─────────────────────────────────────────────────────────

  /** Per-round state hash: prompt, galleryOrder, currentGalleryIndex */
  ROUND_STATE: (roomCode: string, roundNumber: number): string =>
    `sti:v1:room:${roomCode}:round:${roundNumber}:state`,

  /** * Set of playerIds who have submitted a drawing this round.
   * Used directly for dynamic room completion checks.
   */
  ROUND_SUBMITTED: (roomCode: string, roundNumber: number): string =>
    `sti:v1:room:${roomCode}:round:${roundNumber}:submitted`,

  /** * Alternative format alias explicitly tracking round submission arrays.
   * Conforms directly to concurrency lock specifications.
   */
  ROUND_SUBMITTED_SET: (roomCode: string, round: number): string =>
    `sti:v1:room:${roomCode}:round:${round}:submitted`,

  /** Hash of drawingId → serialized vector stroke JSON — PRIMARY purge target */
  ROUND_DRAWINGS: (roomCode: string, roundNumber: number): string =>
    `sti:v1:room:${roomCode}:round:${roundNumber}:drawings`,

  ROUND_TRANSITION_LOCK(roomCode: string): string {
    return `sti:v1:room:${roomCode}:round-transition-lock`;
  },

  // ── Player-Level Keys ────────────────────────────────────────────────────────

  /** Player connection/state tracking hash */
  PLAYER_HASH: (playerId: string): string => `sti:v1:player:${playerId}`,

  /** Player reconnection state tracking key */
  PLAYER_RECONNECT: (playerId: string): string =>
    `sti:v1:player:${playerId}:reconnect`,

  /** Per-player submission lock — SETNX blocks double-submit within a round */
  PLAYER_SUBMISSION_LOCK: (playerId: string): string =>
    `sti:v1:player:${playerId}:submitted`,

  /** * Highly granular per-round player submission lock tracker.
   * Combines playerId and round parameters to reliably evaluate and stop race-condition double-submits.
   */
  SUBMISSION_LOCK: (playerId: string, round: number): string =>
    `sti:v1:player:${playerId}:submitted:${round}`,

  // ── Scoring Keys ─────────────────────────────────────────────────────────────

  /** Global leaderboard hash: playerId → total accumulated stars */
  LEADERBOARD: (roomCode: string): string =>
    `sti:v1:room:${roomCode}:leaderboard`,

  // ── Gallery Voting Keys ──────────────────────────────────────────────────────

  /** Per-drawing voter set — tracks which playerIds have cast a star rating */
  VOTERS: (roomCode: string, roundNumber: number, drawingId: string): string =>
    `sti:v1:room:${roomCode}:round:${roundNumber}:drawing:${drawingId}:voters`,

  // ── Prompt History Keys ──────────────────────────────────────────────────────

  /** Set of already-used prompt strings — prevents duplicate prompts per session */
  USED_PROMPTS: (roomCode: string): string =>
    `sti:v1:room:${roomCode}:used-prompts`,

  // ── Reservation Keys ─────────────────────────────────────────────────────────

  /** Temporary slot reservation key (10s TTL) — written at HTTP join, cleared at WS connect */
  RESERVATION: (roomCode: string, playerId: string): string =>
    `sti:v1:room:${roomCode}:reservation:${playerId}`,
} as const;
