import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { JoinRoomDto } from './dto/join-room.dto';

describe('RoomsController', () => {
  let controller: RoomsController;
  let service: RoomsService;

  const mockRoomsService = {
    createRoom: jest.fn<() => Promise<any>>(),
    joinRoom: jest.fn<(dto: JoinRoomDto) => Promise<any>>(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RoomsController],
      providers: [
        {
          provide: RoomsService,
          useValue: mockRoomsService as unknown as RoomsService,
        },
      ],
    }).compile();

    controller = module.get<RoomsController>(RoomsController);
    service = module.get<RoomsService>(RoomsService);
  });

  describe('createRoom', () => {
    it('should call RoomsService.createRoom and return the result', async () => {
      const mockResult = {
        success: true,
        roomCode: 'ABCDEF',
        hostId: 'usr_123',
        reconnectToken: 'jwt_token',
        message: 'Lobby successfully initialized.',
      };
      mockRoomsService.createRoom.mockResolvedValue(mockResult);

      const result = await controller.createRoom();

      expect(service.createRoom).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });
  });

  describe('joinRoom', () => {
    it('should call RoomsService.joinRoom with dto and return the result', async () => {
      const dto: JoinRoomDto = {
        roomCode: 'ABCDEF',
        username: 'DoodleBob',
      };
      const mockResult = {
        success: true,
        roomCode: 'ABCDEF',
        playerId: 'usr_456',
        reconnectToken: 'jwt_token_guest',
        message: 'Successfully reserved slot.',
      };
      mockRoomsService.joinRoom.mockResolvedValue(mockResult);

      const result = await controller.joinRoom(dto);

      expect(service.joinRoom).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockResult);
    });
  });
});
