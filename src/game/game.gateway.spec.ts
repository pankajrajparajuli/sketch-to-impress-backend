import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { GameGateway } from './game.gateway';
import { RedisService } from '../redis/redis.service';
import { GameService } from './game.service';
import { REDIS_KEYS } from '../redis/redis.keys';
import { RoomStatus } from '../rooms/enums/room-status.enum';
import * as jwt from 'jsonwebtoken';

describe('GameGateway', () => {
  let gateway: GameGateway;
  let redisService: RedisService;
  let gameService: GameService;

  // Mock methods for RedisService
  let mockExists: ReturnType<typeof jest.fn<(key: string) => Promise<boolean>>>;
  let mockHgetall: ReturnType<
    typeof jest.fn<(key: string) => Promise<Record<string, string>>>
  >;
  let mockHget: ReturnType<
    typeof jest.fn<(key: string, field: string) => Promise<string | null>>
  >;
  let mockGet: ReturnType<
    typeof jest.fn<(key: string) => Promise<string | null>>
  >;
  let mockDel: ReturnType<typeof jest.fn<(...keys: string[]) => Promise<void>>>;
  let mockTouchRoom: ReturnType<
    typeof jest.fn<(roomCode: string, currentRound: number) => Promise<void>>
  >;
  let mockHset: ReturnType<
    typeof jest.fn<(key: string, field: string, value: string) => Promise<void>>
  >;

  // Mock methods for GameService
  let mockUpdateRoomSettings: ReturnType<typeof jest.fn>;
  let mockAddPlayerToRoster: ReturnType<typeof jest.fn>;
  let mockGetRoomRoster: ReturnType<typeof jest.fn>;

  // Mock Socket.io server
  const mockServerEmit = jest.fn();
  const mockToEmit = jest.fn();
  const mockServerTo = jest.fn().mockReturnValue({ emit: mockToEmit });
  const mockServer = {
    to: mockServerTo,
    emit: mockServerEmit,
  };

  beforeEach(async () => {
    mockExists = jest.fn<(key: string) => Promise<boolean>>();
    mockHgetall = jest.fn<(key: string) => Promise<Record<string, string>>>();
    mockHget =
      jest.fn<(key: string, field: string) => Promise<string | null>>();
    mockGet = jest.fn<(key: string) => Promise<string | null>>();
    mockDel = jest.fn<(...keys: string[]) => Promise<void>>();
    mockTouchRoom =
      jest.fn<(roomCode: string, currentRound: number) => Promise<void>>();
    mockHset =
      jest.fn<(key: string, field: string, value: string) => Promise<void>>();

    mockUpdateRoomSettings = jest.fn();
    mockAddPlayerToRoster = jest.fn();
    mockGetRoomRoster = jest.fn();

    const mockRedisService = {
      exists: mockExists,
      hgetall: mockHgetall,
      hget: mockHget,
      get: mockGet,
      del: mockDel,
      touchRoom: mockTouchRoom,
      hset: mockHset,
    };

    const mockGameService = {
      updateRoomSettings: mockUpdateRoomSettings,
      addPlayerToRoster: mockAddPlayerToRoster,
      getRoomRoster: mockGetRoomRoster,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameGateway,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
        {
          provide: GameService,
          useValue: mockGameService,
        },
      ],
    }).compile();

    gateway = module.get<GameGateway>(GameGateway);
    redisService = module.get<RedisService>(RedisService);
    gameService = module.get<GameService>(GameService);
    gateway.server = mockServer as any;

    jest.clearAllMocks();
  });

  describe('updateSettings', () => {
    it('should call updateRoomSettings and emit settings changed and updated events to room', async () => {
      const mockClient = {
        data: {
          roomCode: 'ABCDEF',
          playerId: 'host_123',
          isHost: true,
        },
      } as any;
      const dto = {
        timerDuration: 90,
        totalRounds: 3,
        theme: 'CARTOON',
      };

      mockUpdateRoomSettings.mockResolvedValue(undefined);

      await gateway.updateSettings(mockClient, dto);

      expect(gameService.updateRoomSettings).toHaveBeenCalledWith(
        'ABCDEF',
        dto,
      );
      expect(mockServerTo).toHaveBeenCalledWith('ABCDEF');
      expect(mockToEmit).toHaveBeenCalledWith('v1:room:settings_changed', dto);
      expect(mockToEmit).toHaveBeenCalledWith('v1:room:settings_updated', dto);
    });
  });

  describe('handleConnection', () => {
    it('should reject connection if token is missing', async () => {
      const mockClientEmit = jest.fn();
      const mockClientDisconnect = jest.fn();
      const mockClient = {
        id: 'socket_123',
        handshake: {
          auth: {},
          headers: {},
          query: {},
        },
        emit: mockClientEmit,
        disconnect: mockClientDisconnect,
      } as any;

      await gateway.handleConnection(mockClient);

      expect(mockClientEmit).toHaveBeenCalledWith('error:exception', {
        success: false,
        code: 'MISSING_TOKEN',
        message: 'No reconnect token provided.',
      });
      expect(mockClientDisconnect).toHaveBeenCalledWith(true);
    });

    it('should reject connection if token is invalid', async () => {
      const mockClientEmit = jest.fn();
      const mockClientDisconnect = jest.fn();
      const mockClient = {
        id: 'socket_123',
        handshake: {
          auth: { token: 'invalid_token' },
          headers: {},
          query: {},
        },
        emit: mockClientEmit,
        disconnect: mockClientDisconnect,
      } as any;

      await gateway.handleConnection(mockClient);

      expect(mockClientEmit).toHaveBeenCalledWith('error:exception', {
        success: false,
        code: 'INVALID_TOKEN',
        message: 'Token is invalid or expired.',
      });
      expect(mockClientDisconnect).toHaveBeenCalledWith(true);
    });

    it('should reject connection if room does not exist', async () => {
      const token = jwt.sign(
        { playerId: 'usr_1', roomCode: 'ABCDEF', isHost: false },
        'dev_secret',
      );
      const mockClientEmit = jest.fn();
      const mockClientDisconnect = jest.fn();
      const mockClient = {
        id: 'socket_123',
        handshake: {
          auth: { token },
          headers: {},
          query: {},
        },
        emit: mockClientEmit,
        disconnect: mockClientDisconnect,
      } as any;

      mockExists.mockResolvedValue(false); // Room doesn't exist

      await gateway.handleConnection(mockClient);

      expect(mockExists).toHaveBeenCalledWith(REDIS_KEYS.ROOM_META('ABCDEF'));
      expect(mockClientEmit).toHaveBeenCalledWith('error:exception', {
        success: false,
        code: 'ROOM_NOT_FOUND',
        message: 'Room ABCDEF not found.',
      });
      expect(mockClientDisconnect).toHaveBeenCalledWith(true);
    });

    it('should accept connection, set player data, join room, and emit player_joined event for new player', async () => {
      const token = jwt.sign(
        { playerId: 'usr_1', roomCode: 'ABCDEF', isHost: false },
        'dev_secret',
      );
      const mockClientEmit = jest.fn();
      const mockClientDisconnect = jest.fn();
      const mockClientJoin = jest.fn();
      const mockClient = {
        id: 'socket_123',
        handshake: {
          auth: { token },
          headers: {},
          query: {},
        },
        data: {},
        join: mockClientJoin,
        emit: mockClientEmit,
        disconnect: mockClientDisconnect,
      } as any;

      mockExists.mockResolvedValue(true); // Room exists
      mockHgetall.mockImplementation((key) => {
        if (key === REDIS_KEYS.ROOM_STATE('ABCDEF')) {
          return Promise.resolve({
            status: RoomStatus.LOBBY,
            currentRound: '1',
            totalRounds: '3',
            timerDuration: '90',
            theme: 'Cartoon',
          });
        }
        if (key === REDIS_KEYS.PLAYER_HASH('usr_1')) {
          return Promise.resolve({}); // Not reconnecting
        }
        return Promise.resolve({});
      });

      mockGet.mockResolvedValue(
        JSON.stringify({
          playerId: 'usr_1',
          username: 'NewPlayer',
          reservedAt: Date.now(),
        }),
      );
      mockDel.mockResolvedValue(undefined);
      mockAddPlayerToRoster.mockResolvedValue(undefined);

      const mockRoster = [
        {
          playerId: 'usr_1',
          username: 'NewPlayer',
          isHost: false,
          connected: true,
        },
      ];
      mockGetRoomRoster.mockResolvedValue(mockRoster);

      await gateway.handleConnection(mockClient);

      expect(mockClient.data).toEqual({
        playerId: 'usr_1',
        roomCode: 'ABCDEF',
        username: 'NewPlayer',
        isHost: false,
      });

      expect(gameService.addPlayerToRoster).toHaveBeenCalledWith(
        'ABCDEF',
        'usr_1',
        'NewPlayer',
        false,
      );
      expect(mockClientJoin).toHaveBeenCalledWith('ABCDEF');
      expect(mockServerTo).toHaveBeenCalledWith('ABCDEF');
      expect(mockToEmit).toHaveBeenCalledWith('v1:room:player_joined', {
        roomCode: 'ABCDEF',
        players: mockRoster,
      });
    });

    it('should accept connection and emit player:reconnected with snapshot for reconnecting player', async () => {
      const token = jwt.sign(
        { playerId: 'usr_1', roomCode: 'ABCDEF', isHost: false },
        'dev_secret',
      );
      const mockClientEmit = jest.fn();
      const mockClientDisconnect = jest.fn();
      const mockClientJoin = jest.fn();
      const mockClient = {
        id: 'socket_123',
        handshake: {
          auth: { token },
          headers: {},
          query: {},
        },
        data: {},
        join: mockClientJoin,
        emit: mockClientEmit,
        disconnect: mockClientDisconnect,
      } as any;

      mockExists.mockResolvedValue(true); // Room exists
      mockHgetall.mockImplementation((key) => {
        if (key === REDIS_KEYS.ROOM_STATE('ABCDEF')) {
          return Promise.resolve({
            status: RoomStatus.LOBBY,
            currentRound: '1',
            totalRounds: '3',
            timerDuration: '90',
            theme: 'Cartoon',
          });
        }
        if (key === REDIS_KEYS.PLAYER_HASH('usr_1')) {
          return Promise.resolve({
            playerId: 'usr_1',
            username: 'ReconnectingPlayer',
            isHost: 'false',
            connected: 'false',
          }); // Reconnecting!
        }
        if (key === REDIS_KEYS.LEADERBOARD('ABCDEF')) {
          return Promise.resolve({
            usr_1: '10',
          });
        }
        return Promise.resolve({});
      });

      mockAddPlayerToRoster.mockResolvedValue(undefined);
      const mockRoster = [
        {
          playerId: 'usr_1',
          username: 'ReconnectingPlayer',
          isHost: false,
          connected: true,
        },
      ];
      mockGetRoomRoster.mockResolvedValue(mockRoster);

      await gateway.handleConnection(mockClient);

      expect(mockClient.data).toEqual({
        playerId: 'usr_1',
        roomCode: 'ABCDEF',
        username: 'ReconnectingPlayer',
        isHost: false,
      });

      expect(mockClientEmit).toHaveBeenCalledWith(
        'v1:player:reconnected',
        expect.objectContaining({
          roomCode: 'ABCDEF',
          playerId: 'usr_1',
          phase: RoomStatus.LOBBY,
          currentRound: 1,
          totalRounds: 3,
          timerDuration: 90,
          theme: 'Cartoon',
          leaderboard: [
            { playerId: 'usr_1', username: 'ReconnectingPlayer', stars: 10 },
          ],
          players: mockRoster,
        }),
      );
    });
  });

  describe('handleDisconnect', () => {
    it('should set connected to false inside Redis and emit roster updated event if there are still active players', async () => {
      const mockClient = {
        id: 'socket_123',
        data: {
          playerId: 'usr_1',
          roomCode: 'ABCDEF',
          username: 'Bob',
          isHost: false,
        },
      } as any;

      mockExists.mockResolvedValue(true); // Player hash exists
      const mockRoster = [
        { playerId: 'usr_1', username: 'Bob', isHost: false, connected: false },
        { playerId: 'usr_2', username: 'Alice', isHost: true, connected: true },
      ];
      mockGetRoomRoster.mockResolvedValue(mockRoster);
      mockHset.mockResolvedValue(undefined);

      await gateway.handleDisconnect(mockClient);

      expect(mockExists).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('usr_1'));
      expect(mockHset).toHaveBeenCalledWith(
        REDIS_KEYS.PLAYER_HASH('usr_1'),
        'connected',
        'false',
      );
      expect(mockServerTo).toHaveBeenCalledWith('ABCDEF');
      expect(mockToEmit).toHaveBeenCalledWith('v1:room:roster_updated', {
        players: mockRoster,
      });
    });

    it('should evict the room (deleting all room keys) if all players are disconnected', async () => {
      const mockClient = {
        id: 'socket_123',
        data: {
          playerId: 'usr_1',
          roomCode: 'ABCDEF',
          username: 'Bob',
          isHost: false,
        },
      } as any;

      mockExists.mockResolvedValue(true);
      const mockRoster = [
        { playerId: 'usr_1', username: 'Bob', isHost: false, connected: false },
      ];
      mockGetRoomRoster.mockResolvedValue(mockRoster);
      mockHset.mockResolvedValue(undefined);
      mockDel.mockResolvedValue(undefined);

      await gateway.handleDisconnect(mockClient);

      expect(mockExists).toHaveBeenCalledWith(REDIS_KEYS.PLAYER_HASH('usr_1'));
      expect(mockHset).toHaveBeenCalledWith(
        REDIS_KEYS.PLAYER_HASH('usr_1'),
        'connected',
        'false',
      );
      expect(mockDel).toHaveBeenCalledWith(
        REDIS_KEYS.ROOM_META('ABCDEF'),
        REDIS_KEYS.ROOM_PLAYERS('ABCDEF'),
        REDIS_KEYS.ROOM_STATE('ABCDEF'),
        REDIS_KEYS.LEADERBOARD('ABCDEF'),
        REDIS_KEYS.USED_PROMPTS('ABCDEF'),
        REDIS_KEYS.PLAYER_HASH('usr_1'),
      );
    });
  });

  describe('GameGateway Administrative Permissions and Rejections', () => {
    it('should deny updateSettings if the client is not marked as host', async () => {
      const mockClient = {
        id: 'socket_guest',
        data: { playerId: 'usr_2', roomCode: 'ABCDEF', isHost: false },
      } as any;

      // Instantiate your guard manually or via execution context mock to ensure it blocks
      const { GatewayGuard } = require('../common/guards/gateway.guard');
      const guard = new GatewayGuard();

      const mockContext = {
        switchToWs: () => ({
          getClient: () => mockClient,
        }),
      } as any;

      expect(() => guard.canActivate(mockContext)).toThrow();
    });

    it('should cleanly execute rejectClient when jwt verification collapses', async () => {
      const mockClient = {
        id: 'bad_socket',
        emit: jest.fn(),
        disconnect: jest.fn(),
      } as any;

      // Triggering connection rejection pipeline directly
      (gateway as any).rejectClient(
        mockClient,
        'AUTH_FAILED',
        'Invalid token structural hash',
      );

      expect(mockClient.emit).toHaveBeenCalledWith(
        'error:exception',
        expect.objectContaining({ code: 'AUTH_FAILED' }),
      );
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });
  });
});
