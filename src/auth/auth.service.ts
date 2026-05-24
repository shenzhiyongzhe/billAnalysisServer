import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';
import { AuthTokensResponse, PublicUser } from './public-user.dto';

function parseExpiresToSeconds(expires: string | undefined, fallback: number): number {
  if (!expires) return fallback;
  const match = expires.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return fallback;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    case 'd':
      return value * 86400;
    default:
      return fallback;
  }
}

@Injectable()
export class AuthService {
  private readonly accessExpiresIn: string;
  private readonly accessExpiresSeconds: number;
  private readonly refreshExpiresSeconds: number;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {
    this.accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN || '2h';
    this.accessExpiresSeconds = parseExpiresToSeconds(
      this.accessExpiresIn,
      7200,
    );
    this.refreshExpiresSeconds = parseExpiresToSeconds(
      process.env.JWT_REFRESH_EXPIRES_IN,
      30 * 86400,
    );
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  toPublicUser(user: {
    id: number;
    displayId: string;
    nickname: string;
    avatar: string;
    remainingQueries: number;
    level: number;
  }): PublicUser {
    return {
      id: user.id,
      displayId: user.displayId,
      nickname: user.nickname,
      avatar: user.avatar,
      remainingQueries: user.remainingQueries,
      level: user.level,
    };
  }

  async validateAccessToken(token: string): Promise<number> {
    try {
      const payload = await this.jwtService.verifyAsync<{ sub: number }>(token);
      if (!payload?.sub) {
        throw new UnauthorizedException('Invalid access token');
      }
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private async issueTokens(userId: number): Promise<AuthTokensResponse> {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const refreshToken = this.generateRefreshToken();
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + this.refreshExpiresSeconds * 1000);

    await this.prisma.userSession.upsert({
      where: { userId },
      create: {
        userId,
        refreshTokenHash,
        expiresAt,
      },
      update: {
        refreshTokenHash,
        expiresAt,
      },
    });

    const accessToken = await this.jwtService.signAsync({
      sub: userId,
    });

    return {
      user: this.toPublicUser(user),
      accessToken,
      refreshToken,
      expiresIn: this.accessExpiresSeconds,
    };
  }

  async getProfile(userId: number): Promise<PublicUser> {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return this.toPublicUser(user);
  }

  async refreshSession(refreshToken: string): Promise<AuthTokensResponse> {
    if (!refreshToken?.trim()) {
      throw new BadRequestException('refreshToken is required');
    }
    const refreshTokenHash = this.hashRefreshToken(refreshToken.trim());
    const session = await this.prisma.userSession.findFirst({
      where: {
        refreshTokenHash,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    return this.issueTokens(session.userId);
  }

  async revokeSession(userId: number): Promise<void> {
    await this.prisma.userSession.deleteMany({ where: { userId } });
  }

  async wechatLogin(code: string): Promise<AuthTokensResponse> {
    if (!code) throw new BadRequestException('Code is required');

    let openid = code;
    const appId = process.env.WX_APP_ID;
    const secret = process.env.WX_APP_SECRET;

    if (appId && secret) {
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.openid) {
        openid = data.openid;
      } else {
        console.error('WeChat login error:', data);
        throw new BadRequestException('Failed to get openid from WeChat');
      }
    }

    let user = await this.prisma.wechatUser.findUnique({ where: { openid } });

    if (!user) {
      const today = new Date();
      const dateStr =
        today.getFullYear().toString() +
        (today.getMonth() + 1).toString().padStart(2, '0') +
        today.getDate().toString().padStart(2, '0');

      const countToday = await this.prisma.wechatUser.count({
        where: {
          displayId: { startsWith: dateStr },
        },
      });

      const sequence = (countToday + 1).toString().padStart(4, '0');
      const displayId = dateStr + sequence;

      user = await this.prisma.wechatUser.create({
        data: {
          openid,
          displayId,
        },
      });
    }

    return this.issueTokens(user.id);
  }
}
