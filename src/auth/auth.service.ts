import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async wechatLogin(code: string) {
    if (!code) throw new BadRequestException('Code is required');

    let openid = code; // Fallback for mock login
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
      // Create new user with displayId
      const today = new Date();
      const dateStr = today.getFullYear().toString() + 
                      (today.getMonth() + 1).toString().padStart(2, '0') + 
                      today.getDate().toString().padStart(2, '0');
      
      const countToday = await this.prisma.wechatUser.count({
        where: {
          displayId: { startsWith: dateStr }
        }
      });
      
      const sequence = (countToday + 1).toString().padStart(4, '0');
      const displayId = dateStr + sequence;

      user = await this.prisma.wechatUser.create({
        data: {
          openid,
          displayId,
        }
      });
    }

    return user;
  }
}
