import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService } from './auth.service';

/** 有 token 则校验并写入 userId；无 token 也放行（用于匿名错误上报） */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      userId?: number;
    }>();
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return true;
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return true;
    }
    try {
      request.userId = await this.authService.validateAccessToken(token);
    } catch {
      // 无效 token 时仍允许匿名上报
    }
    return true;
  }
}
