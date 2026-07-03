import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * Optional authentication: attaches `request.user` when a valid Bearer token is
 * present, but never rejects the request. Used by public routes that still need
 * to know the caller's identity (e.g. video delivery — anonymous users watch
 * `ready` videos, while the owner may access their own non-ready ones).
 *
 * Pair with `@Public()` so the global `JwtAuthGuard` does not 401 first.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length);
      try {
        request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
      } catch {
        // Invalid/expired token on an optional route → stay anonymous.
      }
    }

    return true;
  }
}
