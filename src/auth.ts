import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

export type AppRole = 'owner' | 'seller';
export interface AuthUser {
  id: string;
  role: AppRole;
}
export type AuthenticatedRequest = Request & { authUser: AuthUser };

export const Roles = (...roles: AppRole[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().authUser,
);

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new UnauthorizedException('API authentication is not configured.');
    }
    try {
      const payload = jwt.verify(token, secret) as jwt.JwtPayload;
      if (
        typeof payload.sub !== 'string' ||
        (payload.role !== 'owner' && payload.role !== 'seller')
      ) {
        throw new Error('Invalid claims');
      }
      request.authUser = { id: payload.sub, role: payload.role };
      return true;
    } catch {
      throw new UnauthorizedException('A valid access token is required.');
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles =
      this.reflector.getAllAndOverride<AppRole[]>('roles', [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (!roles.length) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return roles.includes(request.authUser.role);
  }
}
