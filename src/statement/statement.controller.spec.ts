import { Test, TestingModule } from '@nestjs/testing';
import { StatementController } from './statement.controller';
import { StatementService } from './statement.service';
import { AuthService } from '../auth/auth.service';

describe('StatementController', () => {
  let controller: StatementController;
  let processAndSaveFile: jest.Mock;

  beforeEach(async () => {
    processAndSaveFile = jest
      .fn()
      .mockResolvedValue({ id: 12, isDuplicate: false });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StatementController],
      providers: [
        { provide: StatementService, useValue: { processAndSaveFile } },
        { provide: AuthService, useValue: { validateAccessToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get<StatementController>(StatementController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('forwards the upload request id to the service', async () => {
    const file = {
      buffer: Buffer.from('statement'),
      originalname: '微信账单.pdf',
    };

    await expect(
      controller.uploadFile(
        file,
        7,
        '自定义账单.pdf',
        'upload_request_001',
      ),
    ).resolves.toEqual({ id: 12, isDuplicate: false });

    expect(processAndSaveFile).toHaveBeenCalledWith(
      7,
      file.buffer,
      '自定义账单.pdf',
      'upload_request_001',
    );
  });
});
