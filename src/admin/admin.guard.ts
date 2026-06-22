import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ userId?: number }>();
    const userId = request.userId;
    if (!userId) {
      throw new ForbiddenException('User is not authenticated');
    }

    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
    });

    if (!user || user.level !== 999) {
      throw new ForbiddenException('Require administrator privileges');
    }

    return true;
  }
}
