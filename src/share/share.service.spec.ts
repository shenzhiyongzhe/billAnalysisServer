import { NotFoundException } from '@nestjs/common';
import { ShareService } from './share.service';

describe('ShareService', () => {
  const shareRecordCreate = jest.fn();
  const userUpdate = jest.fn();
  const prisma = {
    wechatUser: {
      findUnique: jest.fn(),
      update: userUpdate,
    },
    queryRecord: {
      findUnique: jest.fn(),
    },
    shareRecord: {
      create: shareRecordCreate,
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const shareCodeService = {
    decode: jest.fn(),
  };
  const service = new ShareService(
    prisma as never,
    shareCodeService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.wechatUser.findUnique.mockResolvedValue({ id: 10 });
    shareRecordCreate.mockResolvedValue({ id: 1 });
    userUpdate.mockResolvedValue({ id: 10 });
  });

  it('records an index share without a query record', async () => {
    shareCodeService.decode.mockReturnValue({ v: 1, sharerId: 10 });

    await expect(service.recordShareOpen('index-code', 20)).resolves.toEqual({
      kind: 'index',
    });
    expect(shareRecordCreate).toHaveBeenCalledWith({
      data: { sharerId: 10, openerId: 20, queryRecordId: undefined },
    });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { shareCount: { increment: 1 } },
    });
  });

  it('records a valid result share and links the query record', async () => {
    shareCodeService.decode.mockReturnValue({
      v: 1,
      sharerId: 10,
      queryRecordId: 99,
    });
    prisma.queryRecord.findUnique.mockResolvedValue({
      id: 99,
      status: 'done',
      createdAt: new Date(),
    });

    await expect(service.recordShareOpen('result-code', 20)).resolves.toEqual({
      kind: 'result',
      queryRecordId: 99,
    });
    expect(shareRecordCreate).toHaveBeenCalledWith({
      data: { sharerId: 10, openerId: 20, queryRecordId: 99 },
    });
  });

  it('does not increment shareCount when opening your own link', async () => {
    shareCodeService.decode.mockReturnValue({ v: 1, sharerId: 10 });

    await service.recordShareOpen('self-code', 10);

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('rejects a result share older than three days', async () => {
    shareCodeService.decode.mockReturnValue({
      v: 1,
      sharerId: 10,
      queryRecordId: 99,
    });
    prisma.queryRecord.findUnique.mockResolvedValue({
      id: 99,
      status: 'done',
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 1),
    });

    await expect(service.recordShareOpen('expired-code', 20)).rejects.toThrow(
      NotFoundException,
    );
    expect(shareRecordCreate).not.toHaveBeenCalled();
  });
});
