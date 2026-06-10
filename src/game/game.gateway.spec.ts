import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GameGateway } from './game.gateway';
import { RedisService } from '../redis/redis.service';
import { GameService } from './game.service';
import { RoomStatus } from '../rooms/enums/room-status.enum';
import { REDIS_KEYS } from '../redis/redis.keys';
import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { SubmitDrawingDto } from './dto/submit-drawing.dto';
import { V1ReconnectState } from './interfaces/v1-reconnect-state.interface';

interface MockServerInstance {
  to: jest.Mock<(roomCode: string) => MockServerInstance>;
  emit: jest.Mock<(event: string, payload: unknown) => MockServerInstance>;
}

interface MockRedisClientInstance {
  hgetall: jest.Mock<() => Promise<Record<string, string>>>;
  set: jest.Mock<
    (key: string, value: string, ...args: any[]) => Promise<string | null>
  >;
  sadd: jest.Mock<() => Promise<number>>;
  scard: jest.Mock<() => Promise<number>>;
  hincrby: jest.Mock<
    (key: string, field: string, increment: number) => Promise<number>
  >;
  del: jest.Mock<() => Promise<number>>;
  get: jest.Mock<() => Promise<string | null>>;
  exists: jest.Mock<() => Promise<number>>;
  hset: jest.Mock<
    (key: string, values: Record<string, string>) => Promise<number>
  >;
  hdel: jest.Mock<() => Promise<number>>;
  pipeline: jest.Mock<() => MockPipelineInstance>;
}

interface MockPipelineInstance {
  set: jest.Mock<() => MockPipelineInstance>;
  sadd: jest.Mock<() => MockPipelineInstance>;
  hdel: jest.Mock<() => MockPipelineInstance>;
  exec: jest.Mock<() => Promise<unknown[]>>;
}

type AppSocket = any;

interface PointDto {
  x: number;
  y: number;
}

interface StrokeDto {
  color: string;
  brushSize: number;
  points: PointDto[];
}

jest.mock('./validators/drawing-payload.validator', () => ({
  validateDrawingPayloadSize: jest.fn<(...args: any[]) => void>(),
}));
jest.mock('./validators/drawing-content.validator', () => ({
  validateVectorOnlyPayload: jest.fn<(...args: any[]) => void>(),
}));

describe('GameGateway', () => {
  let gateway: GameGateway;
  let gameService: jest.Mocked<GameService>;
  let redisService: jest.Mocked<RedisService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  let mockRedisClient: MockRedisClientInstance;
  let mockServer: MockServerInstance;
  let mockSocket: unknown;

  beforeEach(async () => {
    const mockPipeline: MockPipelineInstance = {
      set: jest.fn<() => MockPipelineInstance>(),
      sadd: jest.fn<() => MockPipelineInstance>(),
      hdel: jest.fn<() => MockPipelineInstance>(),
      exec: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    };
    mockPipeline.set.mockReturnValue(mockPipeline);
    mockPipeline.sadd.mockReturnValue(mockPipeline);
    mockPipeline.hdel.mockReturnValue(mockPipeline);

    mockRedisClient = {
      hgetall: jest.fn<() => Promise<Record<string, string>>>(),
      set: jest.fn<
        (key: string, value: string, ...args: any[]) => Promise<string | null>
      >(),
      sadd: jest.fn<() => Promise<number>>(),
      scard: jest.fn<() => Promise<number>>(),
      hincrby: jest
        .fn<
          (key: string, field: string, increment: number) => Promise<number>
        >(),
      del: jest.fn<() => Promise<number>>(),
      get: jest.fn<() => Promise<string | null>>(),
      exists: jest.fn<() => Promise<number>>(),
      hset: jest.fn<
        (key: string, values: Record<string, string>) => Promise<number>
      >(),
      hdel: jest.fn<() => Promise<number>>(),
      pipeline: jest
        .fn<() => MockPipelineInstance>()
        .mockReturnValue(mockPipeline),
    };

    redisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
      exists: jest.fn<() => Promise<boolean>>(),
      hgetall: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      touchRoom: jest.fn(),
    } as unknown as jest.Mocked<RedisService>;

    gameService = {
      registerPhaseChangeCallback: jest.fn(),
      advancePhase: jest.fn(),
      getGalleryOrder: jest.fn(),
      buildGalleryPayload: jest.fn(),
      cacheGalleryOrder: jest.fn(),
      getRoomRoster: jest.fn(),
      getRoomStatus: jest.fn(),
      getUniquePrompt: jest.fn(),
      schedulePhaseTransition: jest.fn(),
      canReconnect: jest.fn(),
      markPlayerConnected: jest.fn(),
      markPlayerDisconnected: jest.fn(),
      buildReconnectSnapshot: jest.fn(),
      createReconnectWindow: jest.fn(),
      addPlayerToRoster: jest.fn(),
      migrateHost: jest.fn(),
      checkRoomOccupancy: jest.fn(),
      countEligibleVoters: jest.fn(),
      getGalleryIndex: jest.fn(),
      setGalleryIndex: jest.fn(),
      deleteGalleryIndex: jest.fn(),
      buildRoundStandings: jest.fn(),
      resetMatch: jest.fn(),
    } as unknown as jest.Mocked<GameService>;

    eventEmitter = {
      emit: jest.fn(),
    } as unknown as jest.Mocked<EventEmitter2>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameGateway,
        { provide: RedisService, useValue: redisService },
        { provide: GameService, useValue: gameService },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    gateway = module.get<GameGateway>(GameGateway);

    mockServer = {
      to: jest.fn<(roomCode: string) => MockServerInstance>(),
      emit: jest.fn<(event: string, payload: unknown) => MockServerInstance>(),
    };
    mockServer.to.mockReturnValue(mockServer);
    mockServer.emit.mockReturnValue(mockServer);

    const gatewayInstance = gateway as any;
    gatewayInstance.server = mockServer;

    mockSocket = {
      id: 'mock-socket-id',
      data: {
        playerId: 'player-123',
        roomCode: 'ABCD',
        isHost: false,
        username: 'TestUser',
      },
      handshake: {
        auth: {},
        headers: {},
        query: {},
      },
      join: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      emit: jest.fn().mockImplementation(function (this: unknown) {
        return this;
      }),
      disconnect: jest.fn().mockImplementation(function (this: unknown) {
        return this;
      }),
    };

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('afterInit', () => {
    it('should register phase change callback and emit event correctly', async () => {
      gateway.afterInit();

      const callbackSpy = gameService.registerPhaseChangeCallback;
      expect(callbackSpy.mock.calls.length).toBeGreaterThan(0);

      mockRedisClient.hgetall.mockResolvedValue({
        currentRound: '1',
        roundEndTimestamp: String(Date.now() + 60000),
        activePrompt: 'Draw a cat',
      });

      const registeredCallback = callbackSpy.mock.calls[0]?.[0];
      if (registeredCallback) {
        await registeredCallback('ROOMX', RoomStatus.DRAWING);
      }

      const toSpy = mockServer.to;
      const emitSpy = mockServer.emit;
      expect(toSpy).toHaveBeenCalledWith('ROOMX');
      expect(emitSpy).toHaveBeenCalledWith('v1:game:phase_changed', {
        roomCode: 'ROOMX',
        status: RoomStatus.DRAWING,
      });
      expect(emitSpy).toHaveBeenCalledWith(
        'v1:game:round_started',
        expect.objectContaining({
          roomCode: 'ROOMX',
          round: 1,
          prompt: 'Draw a cat',
        }),
      );
    });
  });

  describe('handleSubmitDrawing', () => {
    const mockDto: SubmitDrawingDto = {
      strokes: [
        {
          color: '#000000',
          brushSize: 5,
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        },
        {
          color: '#FFFFFF',
          brushSize: 2,
          points: [
            { x: 5, y: 6 },
            { x: 7, y: 8 },
          ],
        },
      ] as StrokeDto[],
    };

    it('should throw an error if room status is not DRAWING', async () => {
      mockRedisClient.hgetall.mockResolvedValue({ status: RoomStatus.LOBBY });

      await expect(async () => {
        await gateway.handleSubmitDrawing(mockSocket as AppSocket, mockDto);
      }).rejects.toThrow(
        `Drawing submissions are only allowed during ${RoomStatus.DRAWING}`,
      );
    });

    it('should return failure if user submission lock fails to acquire', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        status: RoomStatus.DRAWING,
        currentRound: '1',
      });
      mockRedisClient.set.mockResolvedValue(null);

      const result = await gateway.handleSubmitDrawing(
        mockSocket as AppSocket,
        mockDto,
      );

      expect(result).toEqual({
        success: false,
        playerId: 'player-123',
        strokeCount: 0,
      });

      const setSpy = mockRedisClient.set;
      expect(setSpy).toHaveBeenCalledWith(
        REDIS_KEYS.SUBMISSION_LOCK('player-123', 1),
        '1',
        'EX',
        600,
        'NX',
      );
    });

    it('should accept submission and check parameters if player threshold is not yet reached', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        status: RoomStatus.DRAWING,
        currentRound: '1',
      });
      mockRedisClient.set.mockResolvedValue('OK');
      mockRedisClient.scard.mockResolvedValue(1);
      gameService.getRoomRoster.mockResolvedValue([
        {
          playerId: 'player-123',
          connected: true,
          username: 'User1',
          isHost: true,
        },
        {
          playerId: 'player-456',
          connected: true,
          username: 'User2',
          isHost: false,
        },
      ]);

      const result = await gateway.handleSubmitDrawing(
        mockSocket as AppSocket,
        mockDto,
      );

      expect(result).toEqual({
        success: true,
        playerId: 'player-123',
        strokeCount: 2,
      });

      const advancePhaseSpy = gameService.advancePhase;
      expect(advancePhaseSpy).not.toHaveBeenCalled();
    });

    it('should advance phase and kickstart gallery carousel if last player submits drawings', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        status: RoomStatus.DRAWING,
        currentRound: '1',
      });

      mockRedisClient.set
        .mockReturnValueOnce(Promise.resolve('OK'))
        .mockReturnValueOnce(Promise.resolve('OK'));

      mockRedisClient.scard.mockResolvedValue(2);
      gameService.getRoomRoster.mockResolvedValue([
        {
          playerId: 'player-123',
          connected: true,
          username: 'User1',
          isHost: true,
        },
        {
          playerId: 'player-456',
          connected: true,
          username: 'User2',
          isHost: false,
        },
      ]);
      gameService.getGalleryOrder.mockResolvedValue([]);
      gameService.advancePhase.mockResolvedValue({
        next: RoomStatus.GALLERY,
        currentRound: 1,
        prompt: 'Test',
      });

      const result = await gateway.handleSubmitDrawing(
        mockSocket as AppSocket,
        mockDto,
      );

      expect(result).toEqual({
        success: true,
        playerId: 'player-123',
        strokeCount: 2,
      });

      const advancePhaseSpy = gameService.advancePhase;
      expect(advancePhaseSpy).toHaveBeenCalledWith('ABCD');
    });
  });

  describe('castVote', () => {
    const galleryEntry = {
      drawingId: 'draw-999',
      playerId: 'artist-1',
      strokes: [],
    };

    beforeEach(() => {
      mockRedisClient.hgetall.mockResolvedValue({
        status: RoomStatus.GALLERY,
        currentRound: '1',
        activeDrawingId: 'draw-999',
      });
      gameService.getGalleryOrder.mockResolvedValue([galleryEntry] as never);
    });

    it('should return success false if user tries to vote multiple times on same drawing', async () => {
      mockRedisClient.sadd.mockResolvedValue(0);

      const result = await gateway.castVote(mockSocket as AppSocket, {
        stars: 3,
      });
      expect(result).toEqual({ success: false });
    });

    it('should record vote and early-advance gallery when all eligible voters have voted', async () => {
      mockRedisClient.sadd.mockResolvedValue(1);
      gameService.countEligibleVoters.mockResolvedValue(1);
      mockRedisClient.scard.mockResolvedValue(1);
      mockRedisClient.set.mockResolvedValue('OK');
      gameService.getGalleryIndex.mockResolvedValue(1);
      gameService.getGalleryOrder
        .mockResolvedValueOnce([galleryEntry] as never)
        .mockResolvedValueOnce([galleryEntry] as never)
        .mockResolvedValue([]);
      gameService.buildRoundStandings.mockResolvedValue([]);
      gameService.advancePhase.mockResolvedValue({
        next: RoomStatus.ROUND_RESULTS,
      });

      const result = await gateway.castVote(mockSocket as AppSocket, {
        stars: 8,
      });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(result).toEqual({ success: true });
      expect(mockRedisClient.hincrby).toHaveBeenCalledWith(
        REDIS_KEYS.LEADERBOARD('ABCD'),
        'artist-1',
        8,
      );
      expect(gameService.advancePhase).toHaveBeenCalledWith('ABCD');
    });

    it('should block self-votes for the active canvas artist', async () => {
      const artistSocket = {
        ...(mockSocket as Record<string, unknown>),
        data: {
          playerId: 'artist-1',
          roomCode: 'ABCD',
          isHost: false,
          username: 'Artist',
        },
      };

      const result = await gateway.castVote(artistSocket as AppSocket, {
        stars: 5,
      });

      expect(result).toEqual({ success: false });
      expect(mockRedisClient.sadd).not.toHaveBeenCalled();
    });
  });

  describe('startGame', () => {
    it('should skip game start execution if distributed room state lock is engaged', async () => {
      mockRedisClient.set.mockResolvedValue(null);

      await gateway.startGame(mockSocket as AppSocket);

      const statusSpy = gameService.getRoomStatus;
      expect(statusSpy).not.toHaveBeenCalled();
    });

    it('should safely progress if lock is acquired and current phase matches LOBBY', async () => {
      mockRedisClient.set.mockResolvedValue('OK');
      gameService.getRoomStatus.mockResolvedValue(RoomStatus.LOBBY);
      gameService.getUniquePrompt.mockResolvedValue(
        'Draw a futuristic workspace',
      );
      mockRedisClient.hgetall.mockResolvedValue({ timerDuration: '60', roundEndTimestamp: '9999999999999' });

      await gateway.startGame(mockSocket as AppSocket);

      const hsetSpy = mockRedisClient.hset;
      expect(hsetSpy).toHaveBeenCalledWith(REDIS_KEYS.ROOM_STATE('ABCD'), {
        status: RoomStatus.DRAWING,
        currentRound: '1',
      });

      const toSpy = mockServer.to;
      const emitSpy = mockServer.emit;
      expect(toSpy).toHaveBeenCalledWith('ABCD');
      expect(emitSpy).toHaveBeenCalledWith(
        'v1:game:round_started',
        expect.objectContaining({
          roomCode: 'ABCD',
          round: 1,
          prompt: 'Draw a futuristic workspace',
          roundEndTimestamp: expect.any(Number),
          serverTime: expect.any(Number),
        }),
      );

      const transitionSpy = gameService.schedulePhaseTransition;
      expect(transitionSpy).toHaveBeenCalledWith('ABCD', 60);
    });
  });

  describe('handleConnection', () => {
    beforeEach(() => {
      jest.spyOn(jwt, 'verify').mockImplementation(function () {
        return {
          playerId: 'player-123',
          roomCode: 'ABCD',
          isHost: false,
        };
      });
    });

    it('should reject socket client immediately when authorization token is completely omitted', async () => {
      const socketData = mockSocket as Record<string, any>;
      socketData['handshake'] = { auth: {} };

      await gateway.handleConnection(mockSocket as AppSocket);

      const emitSpy = socketData['emit'] as jest.Mock;
      expect(emitSpy).toHaveBeenCalledWith(
        'error:exception',
        expect.objectContaining({
          code: 'MISSING_TOKEN',
        }),
      );
    });

    it('should reject client gracefully when room validation lookup checks fail', async () => {
      const socketData = mockSocket as Record<string, any>;
      socketData['handshake'] = { auth: { token: 'valid-token' } };
      redisService.exists.mockResolvedValue(false);

      await gateway.handleConnection(mockSocket as AppSocket);

      const emitSpy = socketData['emit'] as jest.Mock;
      expect(emitSpy).toHaveBeenCalledWith(
        'error:exception',
        expect.objectContaining({
          code: 'ROOM_NOT_FOUND',
        }),
      );
    });

    it('should reconnect existing player if eligible context is present', async () => {
      const socketData = mockSocket as Record<string, any>;
      socketData['handshake'] = { auth: { token: 'valid-token' } };
      redisService.exists.mockResolvedValue(true);
      gameService.canReconnect.mockResolvedValue(true);
      redisService.hgetall.mockResolvedValue({
        username: 'ReconnectedUser',
      });

      gameService.buildReconnectSnapshot.mockResolvedValue({
        roomCode: 'ABCD',
        playerId: 'player-123',
        currentRound: 1,
        totalRounds: 3,
        phase: RoomStatus.DRAWING,
        timerDuration: 60,
        theme: 'default',
        activePrompt: 'Mock Prompt',
        leaderboard: [],
        players: [],
        remainingSeconds: 45,
        serverTime: Date.now(),
        roundEndTimestamp: Date.now() + 45000,
        galleryEndTimestamp: null,
      } as V1ReconnectState);

      await gateway.handleConnection(mockSocket as AppSocket);

      const connectSpy = gameService.markPlayerConnected;
      expect(connectSpy).toHaveBeenCalledWith('player-123');
    });

    it('should initialize dynamic room profile registry mapping on initial raw player connection entry', async () => {
      const socketData = mockSocket as Record<string, any>;
      socketData['handshake'] = { auth: { token: 'valid-token' } };
      redisService.exists.mockResolvedValue(true);
      gameService.canReconnect.mockResolvedValue(false);
      redisService.get.mockResolvedValue(
        JSON.stringify({ username: 'FreshPlayer' }),
      );
      mockRedisClient.hgetall.mockResolvedValue({
        status: RoomStatus.LOBBY,
        currentRound: '1',
      });
      gameService.getRoomRoster.mockResolvedValue([
        {
          playerId: 'player-123',
          username: 'FreshPlayer',
          connected: true,
          isHost: false,
        },
      ]);

      await gateway.handleConnection(mockSocket as AppSocket);

      const rosterSpy = gameService.addPlayerToRoster;
      expect(rosterSpy).toHaveBeenCalledWith(
        'ABCD',
        'player-123',
        'FreshPlayer',
        false,
      );
    });
  });

  describe('handleDisconnect', () => {
    it('should update availability maps and notify room channels on simple player disconnect', async () => {
      gameService.getRoomRoster.mockResolvedValue([
        {
          playerId: 'player-456',
          username: 'OtherPlayer',
          connected: true,
          isHost: true,
        },
      ]);

      await gateway.handleDisconnect(mockSocket as AppSocket);

      const disconnectSpy = gameService.markPlayerDisconnected;
      const windowSpy = gameService.createReconnectWindow;

      expect(disconnectSpy).toHaveBeenCalledWith('player-123');
      expect(windowSpy).toHaveBeenCalledWith('player-123');
      expect(eventEmitter.emit).toHaveBeenCalledWith('PLAYER_LEFT', {
        roomCode: 'ABCD',
        playerId: 'player-123',
      });
    });
  });

  describe('handlePlayerLeftEvent', () => {
    it('should early-advance gallery when disconnect drops eligible voter threshold', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        status: RoomStatus.GALLERY,
        currentRound: '1',
        activeDrawingId: 'draw-1',
      });
      gameService.getGalleryOrder.mockResolvedValue([
        {
          drawingId: 'draw-1',
          playerId: 'artist-1',
          strokes: [],
        },
      ] as never);
      gameService.countEligibleVoters.mockResolvedValue(1);
      mockRedisClient.scard.mockResolvedValue(1);
      mockRedisClient.set.mockResolvedValue('OK');
      gameService.getGalleryIndex.mockResolvedValue(1);
      gameService.getGalleryOrder.mockResolvedValueOnce([
        {
          drawingId: 'draw-1',
          playerId: 'artist-1',
          strokes: [],
        },
      ] as never);
      gameService.getGalleryOrder.mockResolvedValue([]);
      gameService.buildRoundStandings.mockResolvedValue([]);
      gameService.advancePhase.mockResolvedValue({
        next: RoomStatus.ROUND_RESULTS,
      });

      await gateway.handlePlayerLeftEvent({
        roomCode: 'ABCD',
        playerId: 'player-dropped',
      });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(gameService.advancePhase).toHaveBeenCalledWith('ABCD');
    });
  });

  describe('triggerPlayAgain', () => {
    it('should reset match state and emit lobby event when host confirms', async () => {
      const hostSocket = {
        ...(mockSocket as Record<string, unknown>),
        data: {
          playerId: 'player-123',
          roomCode: 'ABCD',
          isHost: true,
          username: 'Host',
        },
      };

      gameService.resetMatch.mockResolvedValue(undefined);

      const result = await gateway.triggerPlayAgain(hostSocket as AppSocket, {
        confirm: true,
      });

      expect(result).toEqual({ success: true });
      expect(gameService.resetMatch).toHaveBeenCalledWith('ABCD', 'player-123');
      expect(mockServer.emit).toHaveBeenCalledWith('v1:game:lobby_reset', {
        roomCode: 'ABCD',
        status: RoomStatus.LOBBY,
      });
    });

    it('should reject play again when confirmation flag is false', async () => {
      const result = await gateway.triggerPlayAgain(mockSocket as AppSocket, {
        confirm: false,
      });

      expect(result).toEqual({ success: false });
      expect(gameService.resetMatch).not.toHaveBeenCalled();
    });
  });
  // eslint-disable-next-line prettier/prettier
});