import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomPlayer } from './interfaces/v1-room-player.interface';
import {
  V1ReconnectState,
  LeaderboardEntry,
} from './interfaces/v1-reconnect-state.interface';
import { RoomStatus } from '../rooms/enums/room-status.enum';
import { PROMPTS, PromptTheme } from './constants/prompts';
import { GAME_TIMERS } from './constants/game-timers';

import { randomUUID } from 'crypto';
import { GalleryEntry } from './interfaces/v1-gallery-entry.interface';
import { RoundResultEntry } from './interfaces/v1-round-results.interface';
import { CleanupService } from '../common/services/cleanup.service';
import {
  FinalResultEntry,
  MatchOverPayload,
} from './interfaces/v1-final-result.interface'; // Adjust path if needed

const RECONNECT_GRACE_SECONDS = 30;

@Injectable()
export class GameService {
  private readonly phaseTimers = new Map<string, NodeJS.Timeout>();

  // Define the private callback property
  private phaseChangeCallback?: (roomCode: string, status: RoomStatus) => void;

  constructor(
    private readonly redisService: RedisService,
    private readonly cleanupService: CleanupService, // Injected Hooks Provider
  ) {}

  // Add the registration method
  registerPhaseChangeCallback(
    callback: (roomCode: string, status: RoomStatus) => void,
  ): void {
    this.phaseChangeCallback = callback;
  }

  private clearPhaseTimer(roomCode: string): void {
    const timer = this.phaseTimers.get(roomCode);

    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.phaseTimers.delete(roomCode);
  }

  // ─── GALLERY INDEX REDIS PERSISTENCE HELPERS (SPRINT 24 PART 1) ───────────

  async getGalleryIndex(roomCode: string, round: number): Promise<number> {
    const raw = await this.redisService
      .getClient()
      .get(REDIS_KEYS.GALLERY_INDEX(roomCode, round));
    return Number(raw ?? 0);
  }

  async setGalleryIndex(
    roomCode: string,
    round: number,
    index: number,
  ): Promise<void> {
    await this.redisService
      .getClient()
      .set(REDIS_KEYS.GALLERY_INDEX(roomCode, round), index.toString());
  }

  async deleteGalleryIndex(roomCode: string, round: number): Promise<void> {
    await this.redisService
      .getClient()
      .del(REDIS_KEYS.GALLERY_INDEX(roomCode, round));
  }

  // ───────────────────────────────────────────────────────────────────────────

  async cacheGalleryOrder(
    roomCode: string,
    round: number,
    gallery: GalleryEntry[],
  ): Promise<void> {
    await this.redisService
      .getClient()
      .set(REDIS_KEYS.GALLERY_ORDER(roomCode, round), JSON.stringify(gallery));
  }

  async getGalleryOrder(
    roomCode: string,
    round: number,
  ): Promise<GalleryEntry[]> {
    const raw = await this.redisService
      .getClient()
      .get(REDIS_KEYS.GALLERY_ORDER(roomCode, round));

    if (!raw) {
      return [];
    }

    return JSON.parse(raw) as GalleryEntry[];
  }

  async schedulePhaseTransition(
    roomCode: string,
    durationSeconds: number,
  ): Promise<void> {
    const redis = this.redisService.getClient();

    this.clearPhaseTimer(roomCode);

    const roundEndTimestamp = Date.now() + durationSeconds * 1000;

    await redis.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
      roundEndTimestamp: String(roundEndTimestamp),
    });

    const timer = setTimeout(() => {
      this.handlePhaseTimeout(roomCode).catch((err: unknown) => {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown phase timeout error';
        console.error(
          `[GameService] Phase timeout failure for room ${roomCode}:`,
          errorMessage,
        );
      });
    }, durationSeconds * 1000);

    this.phaseTimers.set(roomCode, timer);
  }

  async handlePhaseTimeout(roomCode: string): Promise<void> {
    const currentStatus = await this.getRoomStatus(roomCode);
    if (currentStatus === RoomStatus.GALLERY) {
      return;
    }

    const { next, currentRound } = await this.advancePhase(roomCode);

    switch (next) {
      case RoomStatus.GALLERY: {
        const activeRound = currentRound ?? 1;
        const gallery = await this.getGalleryOrder(roomCode, activeRound);

        const dynamicGallerySeconds =
          gallery.length > 0
            ? gallery.length * GAME_TIMERS.VOTING_SECONDS_PER_CANVAS + 2
            : GAME_TIMERS.GALLERY_SECONDS;

        await this.schedulePhaseTransition(roomCode, dynamicGallerySeconds);
        break;
      }

      case RoomStatus.ROUND_RESULTS:
        break;

      case RoomStatus.DRAWING: {
        const state = await this.redisService
          .getClient()
          .hgetall(REDIS_KEYS.ROOM_STATE(roomCode));

        const drawingTime = Number(state.timerDuration ?? 90);
        await this.schedulePhaseTransition(roomCode, drawingTime);
        break;
      }

      case RoomStatus.FINAL_RESULTS:
        this.clearPhaseTimer(roomCode);
        break;
    }
  }

  async getUsedPrompts(roomCode: string): Promise<string[]> {
    const redis = this.redisService.getClient();
    return redis.smembers(REDIS_KEYS.PROMPT_HISTORY(roomCode));
  }

  async getRoomTheme(roomCode: string): Promise<PromptTheme> {
    const redis = this.redisService.getClient();
    const roomState = await redis.hgetall(REDIS_KEYS.ROOM_STATE(roomCode));
    const theme = roomState.theme ?? 'RANDOM';

    if (
      theme !== 'ANIME' &&
      theme !== 'CARTOON' &&
      theme !== 'GAMING' &&
      theme !== 'RANDOM'
    ) {
      return 'RANDOM';
    }
    return theme;
  }

  async getUniquePrompt(roomCode: string): Promise<string> {
    const redis = this.redisService.getClient();
    const theme = await this.getRoomTheme(roomCode);
    const usedPrompts = await this.getUsedPrompts(roomCode);

    const availablePrompts = PROMPTS[theme].filter(
      (prompt) => !usedPrompts.includes(prompt),
    );

    if (availablePrompts.length === 0) {
      throw new Error(`Prompt pool exhausted for ${theme}`);
    }

    const randomIndex = Math.floor(Math.random() * availablePrompts.length);
    const prompt = availablePrompts[randomIndex];

    if (!prompt) {
      throw new Error(`Failed to retrieve a valid prompt from the pool.`);
    }

    const pipeline = redis.pipeline();
    pipeline.sadd(REDIS_KEYS.PROMPT_HISTORY(roomCode), prompt);
    pipeline.hset(REDIS_KEYS.ROOM_STATE(roomCode), { activePrompt: prompt });
    await pipeline.exec();

    return prompt;
  }

  async updateRoomStatus(roomCode: string, status: RoomStatus): Promise<void> {
    const redis = this.redisService.getClient();
    await redis.hset(REDIS_KEYS.ROOM_STATE(roomCode), { status });
  }

  async getRoomStatus(roomCode: string): Promise<RoomStatus> {
    const redis = this.redisService.getClient();
    const status = await redis.hget(REDIS_KEYS.ROOM_STATE(roomCode), 'status');
    return (status as RoomStatus) ?? RoomStatus.LOBBY;
  }

  async advancePhase(roomCode: string): Promise<{
    next: RoomStatus;
    currentRound?: number;
    prompt?: string;
  }> {
    this.clearPhaseTimer(roomCode);

    const current = await this.getRoomStatus(roomCode);
    let next: RoomStatus;
    let currentRound: number | undefined;
    let prompt: string | undefined;

    const redis = this.redisService.getClient();
    const state = await redis.hgetall(REDIS_KEYS.ROOM_STATE(roomCode));
    const roster = await this.getRoomRoster(roomCode);
    const playerIds = roster.map((p) => p.playerId);
    const totalRounds = Number(state.totalRounds ?? 3);

    switch (current) {
      case RoomStatus.LOBBY:
        next = RoomStatus.DRAWING;
        break;

      case RoomStatus.DRAWING:
        next = RoomStatus.GALLERY;
        break;

      case RoomStatus.GALLERY: {
        next = RoomStatus.ROUND_RESULTS;

        // 🛠️ Hook #1 — ROUND_RESULTS Entry
        // Instantly and aggressively reclaims canvas memory across the roster.
        const targetRound = Number(state.currentRound ?? 1);
        await this.cleanupService.cleanupRoundStrokes(
          roomCode,
          targetRound,
          playerIds,
        );
        break;
      }

      case RoomStatus.ROUND_RESULTS: {
        const roundData = Number(state.currentRound ?? 1);

        if (roundData < totalRounds) {
          currentRound = roundData + 1;

          await redis.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
            currentRound: String(currentRound),
          });

          prompt = await this.getUniquePrompt(roomCode);
          next = RoomStatus.DRAWING;
        } else {
          next = RoomStatus.FINAL_RESULTS;
        }
        break;
      }

      default:
        next = RoomStatus.FINAL_RESULTS;
    }

    await this.updateRoomStatus(roomCode, next);

    if (next === RoomStatus.ROUND_RESULTS) {
      await this.schedulePhaseTransition(
        roomCode,
        GAME_TIMERS.ROUND_RESULTS_SECONDS,
      );
    }

    // Fires synchronous gateway handling loop (transmits final score data downstream)
    this.phaseChangeCallback?.(roomCode, next);

    // 🛠️ Hook #2 — FINAL_RESULTS Delay
    // Reclaims match data cleanly after clients read podium snapshots.
    if (next === RoomStatus.FINAL_RESULTS) {
      const gracePeriodSeconds = 30; // 30-second safe buffer for client UI rendering
      setTimeout(() => {
        this.cleanupService
          .cleanupMatch(roomCode, totalRounds, playerIds)
          .catch((err: unknown) => {
            const errorMessage =
              err instanceof Error ? err.message : 'Unknown cleanup error';
            console.error(
              `[GameService] Deterministic cleanup failure for room ${roomCode}:`,
              errorMessage,
            );
          });
      }, gracePeriodSeconds * 1000);
    }

    return {
      next,
      currentRound,
      prompt,
    };
  }

  async updateRoomSettings(
    roomCode: string,
    settings: { timerDuration: number; totalRounds: number; theme: string },
  ): Promise<void> {
    const redis = this.redisService.getClient();
    await redis.hset(REDIS_KEYS.ROOM_STATE(roomCode), {
      timerDuration: String(settings.timerDuration),
      totalRounds: String(settings.totalRounds),
      theme: settings.theme,
    });
  }

  async addPlayerToRoster(
    roomCode: string,
    playerId: string,
    username: string,
    isHost: boolean,
  ): Promise<void> {
    const redis = this.redisService.getClient();
    const pipeline = redis.pipeline();

    pipeline.sadd(REDIS_KEYS.ROOM_PLAYERS(roomCode), playerId);
    pipeline.hset(REDIS_KEYS.PLAYER_HASH(playerId), {
      playerId,
      username,
      isHost: String(isHost),
      connected: 'true',
    });

    await pipeline.exec();
  }

  async getRoomRoster(roomCode: string): Promise<RoomPlayer[]> {
    const redis = this.redisService.getClient();
    const playerIds = await redis.smembers(REDIS_KEYS.ROOM_PLAYERS(roomCode));

    if (!playerIds || playerIds.length === 0) return [];

    const pipeline = redis.pipeline();
    playerIds.forEach((playerId) => {
      pipeline.hgetall(REDIS_KEYS.PLAYER_HASH(playerId));
    });

    const results = await pipeline.exec();
    if (!results) return [];

    return results
      .map((result) => result[1] as Record<string, string> | null)
      .filter((player): player is Record<string, string> => !!player)
      .map((player) => ({
        playerId: player.playerId ?? '',
        username: player.username ?? '',
        isHost: player.isHost === 'true',
        connected: player.connected === 'true',
      }));
  }

  async markPlayerDisconnected(playerId: string): Promise<void> {
    const redis = this.redisService.getClient();
    await redis.hset(REDIS_KEYS.PLAYER_HASH(playerId), { connected: 'false' });
  }

  async createReconnectWindow(playerId: string): Promise<void> {
    const redis = this.redisService.getClient();
    await redis.set(
      REDIS_KEYS.PLAYER_RECONNECT(playerId),
      'pending',
      'EX',
      RECONNECT_GRACE_SECONDS,
    );
  }

  async canReconnect(playerId: string): Promise<boolean> {
    const redis = this.redisService.getClient();
    const exists = await redis.exists(REDIS_KEYS.PLAYER_RECONNECT(playerId));
    return exists === 1;
  }

  async markPlayerConnected(playerId: string): Promise<void> {
    const redis = this.redisService.getClient();
    const pipeline = redis.pipeline();

    pipeline.hset(REDIS_KEYS.PLAYER_HASH(playerId), { connected: 'true' });
    pipeline.del(REDIS_KEYS.PLAYER_RECONNECT(playerId));
    await pipeline.exec();
  }

  async getConnectedPlayers(roomCode: string): Promise<RoomPlayer[]> {
    const roster = await this.getRoomRoster(roomCode);
    return roster.filter((player) => player.connected);
  }

  async cleanupRoom(roomCode: string): Promise<void> {
    const roster = await this.getRoomRoster(roomCode);
    const playerIds = roster.map((p) => p.playerId);
    await this.cleanupService.cleanupMatch(roomCode, 3, playerIds);
  }

  async migrateHost(roomCode: string): Promise<RoomPlayer | null> {
    const redis = this.redisService.getClient();
    const activePlayers = await this.getConnectedPlayers(roomCode);
    const newHost = activePlayers[0];

    if (!newHost) {
      await this.cleanupRoom(roomCode);
      return null;
    }

    await redis.hset(REDIS_KEYS.PLAYER_HASH(newHost.playerId), {
      isHost: 'true',
    });
    return newHost;
  }

  async checkRoomOccupancy(roomCode: string): Promise<void> {
    const connectedPlayers = await this.getConnectedPlayers(roomCode);
    if (connectedPlayers.length === 0) {
      await this.cleanupRoom(roomCode);
    }
  }

  async buildReconnectSnapshot(
    roomCode: string,
    playerId: string,
  ): Promise<V1ReconnectState> {
    const redis = this.redisService.getClient();
    const state = await redis.hgetall(REDIS_KEYS.ROOM_STATE(roomCode));
    const roster = await this.getRoomRoster(roomCode);
    const leaderboardRaw = await redis.hgetall(
      REDIS_KEYS.LEADERBOARD(roomCode),
    );

    const now = Date.now();
    let remainingSeconds = 0;

    if (state.status === RoomStatus.DRAWING && state.roundEndTimestamp) {
      remainingSeconds = Math.max(
        0,
        Math.ceil((Number(state.roundEndTimestamp) - now) / 1000),
      );
    }

    if (state.status === RoomStatus.GALLERY && state.galleryEndTimestamp) {
      remainingSeconds = Math.max(
        0,
        Math.ceil((Number(state.galleryEndTimestamp) - now) / 1000),
      );
    }

    if (state.status === RoomStatus.ROUND_RESULTS && state.roundEndTimestamp) {
      remainingSeconds = Math.max(
        0,
        Math.ceil((Number(state.roundEndTimestamp) - now) / 1000),
      );
    }

    const leaderboard: LeaderboardEntry[] = roster.map((p) => ({
      playerId: p.playerId,
      username: p.username,
      stars: parseInt(leaderboardRaw[p.playerId] ?? '0', 10),
    }));

    return {
      roomCode,
      playerId,
      phase: (state.status as RoomStatus) ?? RoomStatus.LOBBY,
      currentRound: Number(state.currentRound ?? 1),
      totalRounds: Number(state.totalRounds ?? 3),
      timerDuration: Number(state.timerDuration ?? 90),
      theme: (state.theme as PromptTheme) ?? 'RANDOM',
      activePrompt: state.activePrompt ?? null,
      leaderboard,
      players: roster,

      serverTime: now,
      remainingSeconds,
      roundEndTimestamp: state.roundEndTimestamp
        ? Number(state.roundEndTimestamp)
        : null,
      galleryEndTimestamp: state.galleryEndTimestamp
        ? Number(state.galleryEndTimestamp)
        : null,
    };
  }

  async buildGalleryPayload(
    roomCode: string,
    round: number,
  ): Promise<GalleryEntry[]> {
    const redisClient = this.redisService.getClient();
    const roster = await this.getRoomRoster(roomCode);

    const gallery: GalleryEntry[] = [];

    for (const player of roster) {
      const key = `sti:v1:room:${roomCode}:round:${round}:player:${player.playerId}`;
      const strokes = await redisClient.get(key);
      if (!strokes) continue;

      const parsedStrokes = JSON.parse(strokes) as unknown[];

      gallery.push({
        drawingId: randomUUID(),
        playerId: player.playerId,
        strokes: parsedStrokes,
      } as unknown as GalleryEntry);
    }

    for (let i = gallery.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = gallery[i];
      if (temp && gallery[j]) {
        gallery[i] = gallery[j]!;
        gallery[j] = temp;
      }
    }

    return gallery;
  }

  async buildRoundStandings(roomCode: string): Promise<RoundResultEntry[]> {
    const redis = this.redisService.getClient();
    const leaderboard = await redis.hgetall(REDIS_KEYS.LEADERBOARD(roomCode));
    const roster = await this.getRoomRoster(roomCode);

    const standings = roster.map((player) => ({
      playerId: player.playerId,
      username: player.username,
      score: Number(leaderboard[player.playerId] ?? 0),
    }));

    standings.sort((a, b) => b.score - a.score);

    return standings.map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
  }

  // ─── FINAL STANDINGS & PODIUM BUILDER ──────────────────────────────────────

  async buildFinalStandings(roomCode: string): Promise<FinalResultEntry[]> {
    const redis = this.redisService.getClient();

    const leaderboard = await redis.hgetall(REDIS_KEYS.LEADERBOARD(roomCode));

    const roster = await this.getRoomRoster(roomCode);

    const standings = roster.map((player) => ({
      playerId: player.playerId,
      username: player.username,
      score: Number(leaderboard[player.playerId] ?? 0),
    }));

    standings.sort((a, b) => b.score - a.score);

    return standings.map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
  }

  async buildMatchResults(roomCode: string): Promise<MatchOverPayload> {
    const standings = await this.buildFinalStandings(roomCode);

    return {
      podium: standings.slice(0, 3),
      standings,
    };
  }
}
