export const GAME_TIMERS = {
  VOTING_SECONDS_PER_CANVAS:
    process.env.NODE_ENV === 'test' ? 5 : 1200,
  GALLERY_SECONDS: 10,
  ROUND_RESULTS_SECONDS: 10,
} as const;
