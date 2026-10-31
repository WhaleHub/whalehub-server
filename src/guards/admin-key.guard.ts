import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';

/** Mark a route on a guarded controller as open to everyone. */
export const PUBLIC_ROUTE = 'adminKeyPublic';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/**
 * Operator-only routes. The caller must send header `x-admin-key` equal to the
 * ADMIN_API_KEY env var. If ADMIN_API_KEY is not set, every call is refused, so a
 * missing env var can never leave these routes open.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const expected = process.env.ADMIN_API_KEY || '';
    const req = context.switchToHttp().getRequest();
    const given = String(req.headers?.['x-admin-key'] ?? '');

    if (expected.length < 16 || !safeEqual(given, expected)) {
      throw new UnauthorizedException('admin key required');
    }
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
