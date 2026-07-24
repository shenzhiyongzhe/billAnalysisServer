import { Test, TestingModule } from '@nestjs/testing';
import { StatementController } from './statement.controller';
import { StatementService } from './statement.service';
import { AuthService } from '../auth/auth.service';

describe('StatementController', () => {
  let controller: StatementController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StatementController],
      providers: [
        { provide: StatementService, useValue: {} },
        { provide: AuthService, useValue: { validateAccessToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get<StatementController>(StatementController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
