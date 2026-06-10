import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { GameService } from './game.service';
import { RedisService } from '../redis/redis.service';
import { CleanupService } from '../common/services/cleanup.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomStatus } from '../rooms/enums/room-status.enum';
import { PROMPTS } from './constants/prompts';
import { GAME_TIMERS } from './constants/game-timers';
import { GalleryEntry } from './interfaces/v1-gallery-entry.interface';

describe('GameService', () => {
  let service: GameService;

  // Comprehensive Client Command Mock Definitions
  let mockGet: ReturnType<typeof jest.fn>;
  let mockSet: ReturnType<typeof jest.fn>;
  let mockDel: ReturnType<typeof jest.fn>;
  let mockHset: ReturnType<typeof jest.fn>;
  let mockHget: ReturnType<typeof jest.fn>;
  let mockHgetall: ReturnType<typeof jest.fn>;
  let mockSadd: ReturnType<typeof jest.fn>;
  let mockSmembers: ReturnType<typeof jest.fn>;
  let mockExists: ReturnType<typeof jest.fn>;
  let mockExec: ReturnType<typeof jest.fn>;
  let mockMulti: ReturnType<typeof jest.fn>;
  let mockMultiExec: ReturnType<typeof jest.fn>;

  // Hook Provider Mock Definitions
  let mockCleanupRoundStrokes: ReturnType<typeof jest.fn>;
  let mockCleanupMatch: ReturnType<typeof jest.fn>;

  beforeEach(async () => {
    mockGet = jest.fn();
    mockSet = jest.fn();
    mockDel = jest.fn();
    mockHset = jest.fn();
    mockHget = jest.fn();
    mockHgetall = jest.fn();
    mockSadd = jest.fn();
    mockSmembers = jest.fn();
    mockExists = jest.fn();
    mockExec = jest.fn();
    mockMultiExec = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
    mockMulti = jest.fn().mockReturnValue({
      del: jest.fn().mockReturnThis(),
      hmset: jest.fn().mockReturnThis(),
      exec: mockMultiExec,
    });

    mockCleanupRoundStrokes = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    mockCleanupMatch = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const mockPipeline = {
      sadd: mockSadd,
      hset: mockHset,
      hgetall: mockHgetall,
      del: mockDel,
      exec: mockExec,
    };

    const mockRedisService = {
      getClient: () => ({
        get: mockGet,
        set: mockSet,
        del: mockDel,
        hset: mockHset,
        hget: mockHget,
        hgetall: mockHgetall,
        smembers: mockSmembers,
        exists: mockExists,
        pipeline: () => mockPipeline,
        multi: mockMulti,
      }),
    };

    const mockCleanupService = {
      cleanupRoundStrokes: mockCleanupRoundStrokes,
      cleanupMatch: mockCleanupMatch,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: CleanupService, useValue: mockCleanupService },
      ],
    }).compile();

    service = module.get<GameService>(GameService);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('Callback Subscription Phase Changes', () => {
    it('should assign and successfully fire phase callbacks', async () => {
      const callback = jest.fn();
      service.registerPhaseChangeCallback(callback);

      mockHget.mockResolvedValue(RoomStatus.LOBBY);
      mockHgetall.mockResolvedValue({ totalRounds: '3', currentRound: '1' });
      mockSmembers.mockResolvedValue([]);

      await service.advancePhase('ABCDEF');
      expect(callback).toHaveBeenCalledWith('ABCDEF', RoomStatus.DRAWING);
    });
  });

  describe('Gallery Index Persistence Storage Helpers', () => {
    const roomCode = 'ROOM10';
    const round = 1;

    it('should fallback to 0 index if redis storage returns null', async () => {
      mockGet.mockResolvedValue(null);
      const res = await service.getGalleryIndex(roomCode, round);
      expect(res).toBe(0);
      expect(mockGet).toHaveBeenCalledWith(
        REDIS_KEYS.GALLERY_INDEX(roomCode, round),
      );
    });

    it('should accurately return converted numeric type index values', async () => {
      mockGet.mockResolvedValue('3');
      const res = await service.getGalleryIndex(roomCode, round);
      expect(res).toBe(3);
    });

    it('should write index configuration records down inside persistence', async () => {
      mockSet.mockResolvedValue('OK');
      await service.setGalleryIndex(roomCode, round, 5);
      expect(mockSet).toHaveBeenCalledWith(
        REDIS_KEYS.GALLERY_INDEX(roomCode, round),
        '5',
      );
    });

    it('should drop index targets cleanly via del command', async () => {
      mockDel.mockResolvedValue(1);
      await service.deleteGalleryIndex(roomCode, round);
      expect(mockDel).toHaveBeenCalledWith(
        REDIS_KEYS.GALLERY_INDEX(roomCode, round),
      );
    });
  });

  describe('Gallery Order Cache Subsystems', () => {
    const roomCode = 'ROOM20';
    const round = 2;
    const mockGallery: GalleryEntry[] = [
      {
        drawingId: 'id1',
        playerId: 'p1',
        strokes: [],
      } as unknown as GalleryEntry,
    ];

    it('should serialize and dump complete arrays into cache keys', async () => {
      mockSet.mockResolvedValue('OK');
      await service.cacheGalleryOrder(roomCode, round, mockGallery);
      expect(mockSet).toHaveBeenCalledWith(
        REDIS_KEYS.GALLERY_ORDER(roomCode, round),
        JSON.stringify(mockGallery),
      );
    });

    it('should return empty collections gracefully when cache hits are missing', async () => {
      mockGet.mockResolvedValue(null);
      const res = await service.getGalleryOrder(roomCode, round);
      expect(res).toEqual([]);
    });

    it('should unpack cached entries out to real arrays', async () => {
      mockGet.mockResolvedValue(JSON.stringify(mockGallery));
      const res = await service.getGalleryOrder(roomCode, round);
      expect(res).toEqual(mockGallery);
    });
  });

  describe('Timers & Async Phase Schedulers', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('should persist timestamp calculations and establish a setTimeout execution thread', async () => {
      const roomCode = 'CLOCK1';
      const sec = 15;
      mockHset.mockResolvedValue('OK');
      mockHget.mockResolvedValue(RoomStatus.LOBBY);
      mockHgetall.mockResolvedValue({ totalRounds: '3', currentRound: '1' });
      mockSmembers.mockResolvedValue([]);

      const timeoutSpy = jest
        .spyOn(service, 'handlePhaseTimeout')
        .mockResolvedValue();

      await service.schedulePhaseTransition(roomCode, sec);

      expect(mockHset).toHaveBeenCalledWith(REDIS_KEYS.ROOM_STATE(roomCode), {
        roundEndTimestamp: expect.any(String),
      });

      jest.advanceTimersByTime(sec * 1000);
      expect(timeoutSpy).toHaveBeenCalledWith(roomCode);
    });
  });

  describe('handlePhaseTimeout Rules Evaluation', () => {
    const roomCode = 'TIMEOUT_ROOM';

    it('should bypass operational state updates entirely when active phase evaluates to GALLERY', async () => {
      mockHget.mockResolvedValue(RoomStatus.GALLERY);
      const advanceSpy = jest.spyOn(service, 'advancePhase');

      await service.handlePhaseTimeout(roomCode);
      expect(advanceSpy).not.toHaveBeenCalled();
    });

    it('should dynamically scale transition timelines based on active gallery size', async () => {
      mockHget.mockResolvedValue(RoomStatus.DRAWING);
      jest.spyOn(service, 'advancePhase').mockResolvedValue({
        next: RoomStatus.GALLERY,
        currentRound: 1,
      });

      const mockEntries: GalleryEntry[] = [
        {
          drawingId: '1',
          playerId: 'p1',
          strokes: [],
        } as unknown as GalleryEntry,
        {
          drawingId: '2',
          playerId: 'p2',
          strokes: [],
        } as unknown as GalleryEntry,
      ];
      mockGet.mockResolvedValue(JSON.stringify(mockEntries));

      const transitionSpy = jest
        .spyOn(service, 'schedulePhaseTransition')
        .mockResolvedValue();

      await service.handlePhaseTimeout(roomCode);

      const computedSeconds = 2 * GAME_TIMERS.VOTING_SECONDS_PER_CANVAS + 2;
      expect(transitionSpy).toHaveBeenCalledWith(roomCode, computedSeconds);
    });

    it('should apply baseline safety fallback durations when gallery logs compile empty', async () => {
      mockHget.mockResolvedValue(RoomStatus.DRAWING);
      jest.spyOn(service, 'advancePhase').mockResolvedValue({
        next: RoomStatus.GALLERY,
        currentRound: 1,
      });
      mockGet.mockResolvedValue(null);

      const transitionSpy = jest
        .spyOn(service, 'schedulePhaseTransition')
        .mockResolvedValue();

      await service.handlePhaseTimeout(roomCode);
      expect(transitionSpy).toHaveBeenCalledWith(
        roomCode,
        GAME_TIMERS.GALLERY_SECONDS,
      );
    });

    it('should transition into DRAWING using specific runtime user settings configuration', async () => {
      mockHget.mockResolvedValue(RoomStatus.ROUND_RESULTS);
      jest.spyOn(service, 'advancePhase').mockResolvedValue({
        next: RoomStatus.DRAWING,
      });

      mockHgetall.mockResolvedValue({ timerDuration: '45' });
      const transitionSpy = jest
        .spyOn(service, 'schedulePhaseTransition')
        .mockResolvedValue();

      await service.handlePhaseTimeout(roomCode);
      expect(transitionSpy).toHaveBeenCalledWith(roomCode, 45);
    });

    it('should drop local clock tracking registers on entering FINAL_RESULTS', async () => {
      mockHget.mockResolvedValue(RoomStatus.ROUND_RESULTS);
      jest.spyOn(service, 'advancePhase').mockResolvedValue({
        next: RoomStatus.FINAL_RESULTS,
      });

      const transitionSpy = jest.spyOn(service, 'schedulePhaseTransition');
      await service.handlePhaseTimeout(roomCode);
      expect(transitionSpy).not.toHaveBeenCalled();
    });
  });

  describe('Prompt Randomizer Mechanics & Pool Systems', () => {
    const roomCode = 'PROMPT_ROOM';

    it('should parse and download historical prompt items out of Redis sets', async () => {
      mockSmembers.mockResolvedValue(['Prompt X', 'Prompt Y']);
      const res = await service.getUsedPrompts(roomCode);
      expect(res).toEqual(['Prompt X', 'Prompt Y']);
    });

    it('should secure corrupted config files by falling back to RANDOM defaults', async () => {
      mockHgetall.mockResolvedValue({});
      let theme = await service.getRoomTheme(roomCode);
      expect(theme).toBe('RANDOM');

      mockHgetall.mockResolvedValue({ theme: 'INVALID_THEME_STRING' });
      theme = await service.getRoomTheme(roomCode);
      expect(theme).toBe('RANDOM');
    });

    it('should parse explicitly validated matching system theme configurations', async () => {
      mockHgetall.mockResolvedValue({ theme: 'CARTOON' });
      const theme = await service.getRoomTheme(roomCode);
      expect(theme).toBe('CARTOON');
    });

    it('should fail with an exception error block when unique choices deplete completely', async () => {
      mockHgetall.mockResolvedValue({ theme: 'ANIME' });
      mockSmembers.mockResolvedValue(PROMPTS['ANIME']);

      await expect(service.getUniquePrompt(roomCode)).rejects.toThrow(
        'Prompt pool exhausted for ANIME',
      );
    });

    it('should select an option and pipe modifications safely into transactional queries', async () => {
      mockHgetall.mockResolvedValue({ theme: 'GAMING' });
      const selectedPrompt = PROMPTS['GAMING'][0]!;
      const historicalDuplicates = PROMPTS['GAMING'].slice(1);
      mockSmembers.mockResolvedValue(historicalDuplicates);
      mockExec.mockResolvedValue([]);

      const res = await service.getUniquePrompt(roomCode);
      expect(res).toBe(selectedPrompt);
      expect(mockSadd).toHaveBeenCalledWith(
        REDIS_KEYS.PROMPT_HISTORY(roomCode),
        selectedPrompt,
      );
      expect(mockExec).toHaveBeenCalled();
    });
  });

  describe('FSM Core State Transition Matrix (advancePhase)', () => {
    const roomCode = 'FSM_ROOM';

    it('should progress from LOBBY directly into DRAWING', async () => {
      mockHget.mockResolvedValue(RoomStatus.LOBBY);
      mockHgetall.mockResolvedValue({ totalRounds: '3', currentRound: '1' });
      mockSmembers.mockResolvedValue([]);

      const result = await service.advancePhase(roomCode);
      expect(result.next).toBe(RoomStatus.DRAWING);
    });

    it('should step out from DRAWING directly into GALLERY', async () => {
      mockHget.mockResolvedValue(RoomStatus.DRAWING);
      mockHgetall.mockResolvedValue({ totalRounds: '3', currentRound: '1' });
      mockSmembers.mockResolvedValue([]);

      const result = await service.advancePhase(roomCode);
      expect(result.next).toBe(RoomStatus.GALLERY);
    });

    it('should route GALLERY frames cleanly inside ROUND_RESULTS while clearing stroke logs', async () => {
      mockHget.mockResolvedValue(RoomStatus.GALLERY);
      mockHgetall.mockResolvedValue({ totalRounds: '3', currentRound: '2' });
      mockSmembers.mockResolvedValue(['p1']);
      mockExec.mockResolvedValue([
        [null, { playerId: 'p1', connected: 'true' }],
      ]);

      const result = await service.advancePhase(roomCode);
      expect(result.next).toBe(RoomStatus.ROUND_RESULTS);
      expect(mockCleanupRoundStrokes).toHaveBeenCalledWith(roomCode, 2, ['p1']);

      (service as unknown as { clearPhaseTimer: (code: string) => void }).clearPhaseTimer(
        roomCode,
      );
    });

    it('should iterate round counts and move to DRAWING if maximum rounds remain unmatched', async () => {
      mockHget.mockResolvedValue(RoomStatus.ROUND_RESULTS);
      mockHgetall.mockResolvedValue({
        totalRounds: '3',
        currentRound: '1',
        theme: 'RANDOM',
      });
      mockSmembers.mockResolvedValue([]);

      const result = await service.advancePhase(roomCode);
      expect(result.next).toBe(RoomStatus.DRAWING);
      expect(result.currentRound).toBe(2);
    });

    it('should push execution to FINAL_RESULTS and clean up matches after thresholds break', async () => {
      mockHget.mockResolvedValue(RoomStatus.ROUND_RESULTS);
      mockHgetall.mockResolvedValue({ totalRounds: '3', currentRound: '3' });
      mockSmembers.mockResolvedValue(['p1']);
      mockExec.mockResolvedValue([[null, { playerId: 'p1' }]]);

      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const callsBefore = setTimeoutSpy.mock.calls.length;

      const result = await service.advancePhase(roomCode);
      expect(result.next).toBe(RoomStatus.FINAL_RESULTS);

      const cleanupCall = setTimeoutSpy.mock.calls
        .slice(callsBefore)
        .find((call) => call[1] === 30000);
      expect(cleanupCall).toBeDefined();

      const cleanupCallback = cleanupCall?.[0] as () => void;
      cleanupCallback();

      expect(mockCleanupMatch).toHaveBeenCalledWith(roomCode, 3, ['p1']);
      setTimeoutSpy.mockRestore();
    });
  });

  describe('updateRoomSettings & Disconnect State Controls', () => {
    it('should update room settings inside the ROOM_STATE hash map', async () => {
      mockHset.mockResolvedValue('OK');
      await service.updateRoomSettings('ROOM_A', {
        timerDuration: 60,
        totalRounds: 3,
        theme: 'RANDOM',
      });
      expect(mockHset).toHaveBeenCalledWith(REDIS_KEYS.ROOM_STATE('ROOM_A'), {
        timerDuration: '60',
        totalRounds: '3',
        theme: 'RANDOM',
      });
    });

    it('should toggle connectivity mapping properties to false during disconnects', async () => {
      mockHset.mockResolvedValue('OK');
      await service.markPlayerDisconnected('p1');
      expect(mockHset).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('p1'), {
        connected: 'false',
      });
    });

    it('should construct short-lived reconnection timeout buffers', async () => {
      mockSet.mockResolvedValue('OK');
      await service.createReconnectWindow('p1');
      expect(mockSet).toHaveBeenCalledWith(
        REDIS_KEYS.PLAYER_RECONNECT('p1'),
        'pending',
        'EX',
        30,
      );
    });

    it('should look up existence constraints on active drop targets', async () => {
      mockExists.mockResolvedValue(1);
      const res = await service.canReconnect('p1');
      expect(res).toBe(true);
    });

    it('should restore structural player maps and drop timeout arrays upon registration reconnects', async () => {
      await service.markPlayerConnected('p1');
      expect(mockHset).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('p1'), {
        connected: 'true',
      });
      expect(mockDel).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_RECONNECT('p1'));
    });
  });

  describe('Roster Management & Player Sync Layers', () => {
    const roomCode = 'ROSTER_ROOM';

    it('should add playerId to ROOM_PLAYERS set and write connection details to PLAYER_HASH', async () => {
      mockExec.mockResolvedValue([]);
      await service.addPlayerToRoster(roomCode, 'p1', 'Artist', true);
      expect(mockSadd).toHaveBeenCalledWith(
        REDIS_KEYS.ROOM_PLAYERS(roomCode),
        'p1',
      );
      expect(mockHset).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('p1'), {
        playerId: 'p1',
        username: 'Artist',
        isHost: 'true',
        connected: 'true',
      });
    });

    it('should return empty arrays safely when player mapping queries evaluate empty', async () => {
      mockSmembers.mockResolvedValue([]);
      const res = await service.getRoomRoster(roomCode);
      expect(res).toEqual([]);
    });

    it('should compile full roster logs extracted out from multi-exec pipelines', async () => {
      mockSmembers.mockResolvedValue(['p1']);
      mockExec.mockResolvedValue([
        [
          null,
          { playerId: 'p1', username: 'A', isHost: 'false', connected: 'true' },
        ],
      ]);

      const res = await service.getRoomRoster(roomCode);
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({
        playerId: 'p1',
        username: 'A',
        isHost: false,
        connected: true,
      });
    });

    it('should extract active connected users out of baseline arrays', async () => {
      mockSmembers.mockResolvedValue(['p1', 'p2']);
      mockExec.mockResolvedValue([
        [
          null,
          { playerId: 'p1', username: 'A', isHost: 'true', connected: 'true' },
        ],
        [
          null,
          {
            playerId: 'p2',
            username: 'B',
            isHost: 'false',
            connected: 'false',
          },
        ],
      ]);

      const res = await service.getConnectedPlayers(roomCode);
      expect(res).toHaveLength(1);
      expect(res[0]?.playerId).toBe('p1');
    });
  });

  describe('Host Migration Routines', () => {
    const roomCode = 'MIGRATE_ROOM';

    it('should execute comprehensive cleanup routines instantly when total populations hit zero', async () => {
      mockSmembers.mockResolvedValue([]);
      await service.checkRoomOccupancy(roomCode);
      expect(mockCleanupMatch).toHaveBeenCalled();
    });

    it('should automatically assign hosting authority privileges to adjacent peers during host disconnects', async () => {
      mockSmembers.mockResolvedValue(['p1']);
      mockExec.mockResolvedValue([
        [
          null,
          { playerId: 'p1', username: 'A', isHost: 'false', connected: 'true' },
        ],
      ]);

      const updatedHost = await service.migrateHost(roomCode);
      expect(updatedHost?.playerId).toBe('p1');
      expect(mockHset).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('p1'), {
        isHost: 'true',
      });
    });

    it('should return null and clean room components when migration workflows fail completely', async () => {
      mockSmembers.mockResolvedValue([]);
      const updatedHost = await service.migrateHost(roomCode);
      expect(updatedHost).toBeNull();
      expect(mockCleanupMatch).toHaveBeenCalled();
    });
  });

  describe('Payload Hydration & Metric Calculation Pipelines', () => {
    const roomCode = 'HYDRATION_ROOM';

    it('should calculate accurate remaining seconds during recovery snapshot processes', async () => {
      const currentTick = 2000000000000;
      jest.spyOn(Date, 'now').mockReturnValue(currentTick);

      mockHgetall.mockImplementation((key: string) => {
        if (key === REDIS_KEYS.ROOM_STATE(roomCode)) {
          return Promise.resolve({
            status: RoomStatus.DRAWING,
            currentRound: '1',
            totalRounds: '3',
            timerDuration: '60',
            theme: 'GAMING',
            activePrompt: 'Zelda',
            roundEndTimestamp: String(currentTick + 30000),
          });
        }
        if (key === REDIS_KEYS.LEADERBOARD(roomCode)) {
          return Promise.resolve({ p1: '40' });
        }
        return Promise.resolve({});
      });

      mockSmembers.mockResolvedValue(['p1']);
      mockExec.mockResolvedValue([
        [
          null,
          { playerId: 'p1', username: 'P1', isHost: 'true', connected: 'true' },
        ],
      ]);

      const snapshot = await service.buildReconnectSnapshot(roomCode, 'p1');
      expect(snapshot.remainingSeconds).toBe(30);
      expect(snapshot.phase).toBe(RoomStatus.DRAWING);
      expect(snapshot.leaderboard[0]).toEqual({
        playerId: 'p1',
        username: 'P1',
        stars: 40,
      });
    });

    it('should parse user canvas strokes out from serialization storage and build structural payloads', async () => {
      mockSmembers.mockResolvedValue(['p1']);
      mockExec.mockResolvedValue([
        [null, { playerId: 'p1', connected: 'true' }],
      ]);
      mockGet.mockResolvedValue(JSON.stringify([{ x: 10, y: 20 }]));

      const gallery = await service.buildGalleryPayload(roomCode, 1);
      expect(gallery).toHaveLength(1);
      expect(gallery[0]?.playerId).toBe('p1');
    });

    it('should compute scoreboard placement ordering sorted by high score performance', async () => {
      mockHgetall.mockResolvedValue({ p1: '10', p2: '90' });
      mockSmembers.mockResolvedValue(['p1', 'p2']);
      mockExec.mockResolvedValue([
        [null, { playerId: 'p1', username: 'PlayerOne' }],
        [null, { playerId: 'p2', username: 'PlayerTwo' }],
      ]);

      const scoreStandings = await service.buildRoundStandings(roomCode);
      expect(scoreStandings).toHaveLength(2);
      expect(scoreStandings[0]?.playerId).toBe('p2');
      expect(scoreStandings[0]?.rank).toBe(1);
      expect(scoreStandings[1]?.playerId).toBe('p1');
      expect(scoreStandings[1]?.rank).toBe(2);
    });
  });

  describe('Eligible voter counting', () => {
    it('should exclude disconnected players and the active artist', async () => {
      mockSmembers.mockResolvedValue(['p1', 'p2', 'p3']);
      mockExec.mockResolvedValue([
        [
          null,
          { playerId: 'p1', username: 'A', connected: 'true', isHost: 'true' },
        ],
        [
          null,
          { playerId: 'p2', username: 'B', connected: 'true', isHost: 'false' },
        ],
        [
          null,
          {
            playerId: 'p3',
            username: 'C',
            connected: 'false',
            isHost: 'false',
          },
        ],
      ]);

      const count = await service.countEligibleVoters('ROOM1', 'p1');
      expect(count).toBe(1);
    });
  });

  describe('Match results and reset flows', () => {
    const roomCode = 'MATCH1';

    it('should build ranked podium payload for match over broadcasts', async () => {
      mockHgetall.mockResolvedValue({ p1: '10', p2: '25', p3: '15' });
      mockSmembers.mockResolvedValue(['p1', 'p2', 'p3']);
      mockExec.mockResolvedValue([
        [null, { playerId: 'p1', username: 'One' }],
        [null, { playerId: 'p2', username: 'Two' }],
        [null, { playerId: 'p3', username: 'Three' }],
      ]);

      const results = await service.buildMatchResults(roomCode);

      expect(results.standings[0]).toEqual(
        expect.objectContaining({ playerId: 'p2', rank: 1, score: 25 }),
      );
      expect(results.podium).toHaveLength(3);
      expect(results.podium[0]?.playerId).toBe('p2');
    });

    it('should reject reset when caller is not the room host', async () => {
      mockHgetall.mockResolvedValue({ hostId: 'host-1' });

      await expect(service.resetMatch(roomCode, 'not-host')).rejects.toThrow(
        'Only host may restart match.',
      );
    });

    it('should execute atomic multi reset for play again', async () => {
      mockHgetall
        .mockResolvedValueOnce({ hostId: 'host-1' })
        .mockResolvedValueOnce({ totalRounds: '2' });
      mockSmembers.mockResolvedValue(['p1']);
      mockExec.mockResolvedValue([[null, { playerId: 'p1' }]]);

      await service.resetMatch(roomCode, 'host-1');

      expect(mockMulti).toHaveBeenCalled();
      expect(mockMultiExec).toHaveBeenCalled();
    });

    it('should compute gallery remaining seconds in reconnect snapshots', async () => {
      const currentTick = 2000000000000;
      jest.spyOn(Date, 'now').mockReturnValue(currentTick);

      mockHgetall.mockImplementation((key: string) => {
        if (key === REDIS_KEYS.ROOM_STATE(roomCode)) {
          return Promise.resolve({
            status: RoomStatus.GALLERY,
            currentRound: '1',
            totalRounds: '1',
            timerDuration: '60',
            theme: 'GAMING',
            galleryEndTimestamp: String(currentTick + 15000),
          });
        }
        if (key === REDIS_KEYS.LEADERBOARD(roomCode)) {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      mockSmembers.mockResolvedValue(['p1']);
      mockExec.mockResolvedValue([
        [
          null,
          { playerId: 'p1', username: 'P1', isHost: 'true', connected: 'true' },
        ],
      ]);

      const snapshot = await service.buildReconnectSnapshot(roomCode, 'p1');
      expect(snapshot.remainingSeconds).toBe(15);
      expect(snapshot.galleryEndTimestamp).toBe(currentTick + 15000);
    });
  });
});
