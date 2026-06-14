export const GAME_TIMERS = {
  get VOTING_SECONDS_PER_CANVAS(): number {
    return Number(process.env.VOTING_SECONDS_PER_CANVAS ?? 120);
  },
  GALLERY_SECONDS: 10,
  ROUND_RESULTS_SECONDS: 10,
};
