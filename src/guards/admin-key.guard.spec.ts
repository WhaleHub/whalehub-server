import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminKeyGuard } from './admin-key.guard';

const ctx = (headers: Record<string, string>, isPublic = false) => {
  const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
  const context = {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
  return { guard: new AdminKeyGuard(reflector), context };
};

describe('AdminKeyGuard', () => {
  const KEY = 'a'.repeat(32);
  afterEach(() => delete process.env.ADMIN_API_KEY);

  it('refuses everything when ADMIN_API_KEY is unset', () => {
    const { guard, context } = ctx({ 'x-admin-key': '' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('refuses a missing or wrong key', () => {
    process.env.ADMIN_API_KEY = KEY;
    expect(() => ctx({}).guard.canActivate(ctx({}).context)).toThrow(UnauthorizedException);
    const w = ctx({ 'x-admin-key': 'b'.repeat(32) });
    expect(() => w.guard.canActivate(w.context)).toThrow(UnauthorizedException);
  });

  it('refuses a short key even if it matches', () => {
    process.env.ADMIN_API_KEY = 'short';
    const { guard, context } = ctx({ 'x-admin-key': 'short' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('allows the right key', () => {
    process.env.ADMIN_API_KEY = KEY;
    const { guard, context } = ctx({ 'x-admin-key': KEY });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows @Public routes without a key', () => {
    const { guard, context } = ctx({}, true);
    expect(guard.canActivate(context)).toBe(true);
  });
});
