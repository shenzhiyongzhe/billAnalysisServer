import { ForbiddenException } from '@nestjs/common';
import { ShareCodeService } from './share-code.service';

describe('ShareCodeService', () => {
  const originalSecret = process.env.SHARE_CODE_SECRET;

  beforeEach(() => {
    process.env.SHARE_CODE_SECRET =
      'test-share-code-secret-with-at-least-32-characters';
  });

  afterAll(() => {
    if (originalSecret == null) {
      delete process.env.SHARE_CODE_SECRET;
    } else {
      process.env.SHARE_CODE_SECRET = originalSecret;
    }
  });

  it('round-trips an index share code', () => {
    const service = new ShareCodeService();
    const code = service.createIndexCode(42);

    expect(service.decode(code)).toEqual({ v: 1, sharerId: 42 });
  });

  it('round-trips a result share code', () => {
    const service = new ShareCodeService();
    const code = service.createResultCode(42, 99);

    expect(service.decode(code)).toEqual({
      v: 1,
      sharerId: 42,
      queryRecordId: 99,
    });
  });

  it('rejects a tampered code', () => {
    const service = new ShareCodeService();
    const code = service.createResultCode(42, 99);
    const replacement = code.endsWith('A') ? 'B' : 'A';

    expect(() => service.decode(`${code.slice(0, -1)}${replacement}`)).toThrow(
      ForbiddenException,
    );
  });

  it('rejects invalid IDs before encryption', () => {
    const service = new ShareCodeService();

    expect(() => service.createIndexCode(0)).toThrow(
      'Share IDs must be positive integers',
    );
    expect(() => service.createResultCode(1, -1)).toThrow(
      'Share IDs must be positive integers',
    );
  });
});
