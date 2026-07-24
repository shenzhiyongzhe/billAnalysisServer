export interface PublicUser {
  id: number;
  displayId: string;
  nickname: string;
  avatar: string;
  remainingQueries: number;
  level: number;
  totalQueries: number;
  monthlyCardExpiry?: string | null; // 月卡到期时间 ISO 字符串，null/undefined 表示无月卡
  shareCode: string;
}

export interface AuthTokensResponse {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
