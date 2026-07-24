import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

export type ShareCodePayload = {
  v: 1;
  sharerId: number;
  queryRecordId?: number;
};

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEV_FALLBACK_SECRET = 'dev-share-code-secret-change-in-production';

@Injectable()
export class ShareCodeService {
  private readonly logger = new Logger(ShareCodeService.name);
  private readonly key: Buffer;

  constructor() {
    let secret = process.env.SHARE_CODE_SECRET?.trim();
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('SHARE_CODE_SECRET is required in production');
      }
      secret = process.env.JWT_SECRET?.trim() || DEV_FALLBACK_SECRET;
      this.logger.warn(
        'SHARE_CODE_SECRET is not set; using a development-only fallback',
      );
    }
    this.key = createHash('sha256').update(secret).digest();
  }

  createIndexCode(sharerId: number): string {
    return this.encrypt({ v: 1, sharerId });
  }

  createResultCode(sharerId: number, queryRecordId: number): string {
    return this.encrypt({ v: 1, sharerId, queryRecordId });
  }

  decode(code: string): ShareCodePayload {
    try {
      const packed = Buffer.from(String(code || ''), 'base64url');
      if (packed.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error('Invalid encrypted payload length');
      }

      const iv = packed.subarray(0, IV_LENGTH);
      const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString('utf8');
      const payload = JSON.parse(plaintext) as Partial<ShareCodePayload>;

      if (payload.v !== 1 || !this.isPositiveInteger(payload.sharerId)) {
        throw new Error('Invalid share payload');
      }
      if (
        payload.queryRecordId != null &&
        !this.isPositiveInteger(payload.queryRecordId)
      ) {
        throw new Error('Invalid queryRecordId');
      }

      return {
        v: 1,
        sharerId: payload.sharerId,
        ...(payload.queryRecordId != null
          ? { queryRecordId: payload.queryRecordId }
          : {}),
      };
    } catch {
      throw new ForbiddenException('分享链接无效');
    }
  }

  private encrypt(payload: ShareCodePayload): string {
    if (
      !this.isPositiveInteger(payload.sharerId) ||
      (payload.queryRecordId != null &&
        !this.isPositiveInteger(payload.queryRecordId))
    ) {
      throw new Error('Share IDs must be positive integers');
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64url',
    );
  }

  private isPositiveInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) > 0;
  }
}
