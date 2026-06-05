import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

interface AuthenticatedClientData {
  playerId: string;
  roomCode: string;
  isHost: boolean;
}

@Injectable()
export class GatewayGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Explicitly cast the untyped client to a socket instance matching your architecture
    const client = context.switchToWs().getClient<Socket>();

    // Extrapolate and cast data to prevent implicit 'any' access errors
    const clientData = client.data as
      | Partial<AuthenticatedClientData>
      | undefined;

    if (!clientData?.isHost) {
      throw new WsException('Only host can perform this action');
    }

    return true;
  }
}
