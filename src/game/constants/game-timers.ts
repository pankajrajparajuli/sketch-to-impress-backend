export const GAME_TIMERS = {
  get VOTING_SECONDS_PER_CANVAS(): number {
    return Number(process.env.VOTING_SECONDS_PER_CANVAS ?? 120);
  },
  get GALLERY_SECONDS(): number {
    return Number(process.env.GALLERY_SECONDS ?? 10);
  },
  get ROUND_RESULTS_SECONDS(): number {
    return Number(process.env.ROUND_RESULTS_SECONDS ?? 10);
  },
};
