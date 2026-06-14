import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.keys';

interface AuthenticatedClientData {
  playerId: string;
  roomCode: string;
  isHost: boolean;
}

@Injectable()
export class GatewayGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const clientData = client.data as
      | Partial<AuthenticatedClientData>
      | undefined;

    const playerId = clientData?.playerId;
    const roomCode = clientData?.roomCode;

    if (!playerId || !roomCode) {
      throw new WsException('Only host can perform this action');
    }

    // Validate against Redis ROOM_META rather than the JWT-baked isHost flag.
    // This correctly handles host migrations where the new host's JWT still
    // carries isHost: false from their original join.
    const meta = await this.redis.getClient().hgetall(REDIS_KEYS.ROOM_META(roomCode));
    if (!meta || meta.hostId !== playerId) {
      throw new WsException('Only host can perform this action');
    }

    return true;
  }
}
