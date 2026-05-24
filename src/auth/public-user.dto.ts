export interface PublicUser {
  id: number;
  displayId: string;
  nickname: string;
  avatar: string;
  remainingQueries: number;
  level: number;
}

export interface AuthTokensResponse {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
