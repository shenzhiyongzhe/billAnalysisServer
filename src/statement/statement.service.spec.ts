import { Test, TestingModule } from '@nestjs/testing';
import { StatementService } from './statement.service';
import { PrismaService } from '../prisma.service';

describe('StatementService', () => {
  let service: StatementService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatementService,
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    service = module.get<StatementService>(StatementService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('parseWechatTransactions', () => {
    const parse = (text: string) =>
      (service as unknown as { parseWechatTransactions(t: string): unknown[] }).parseWechatTransactions(text);

    it('parses 其他 type with counterparty / when both fields are /', () => {
      const text = [
        '10001073012026051201337011622559',
        '2026-05-12',
        '01:22:34',
        '零钱通转出-',
        '到零钱',
        '其他 零钱通 5.00 / /',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-05-12 01:22:34',
        type: '不计收支',
        amount: 5,
        counterparty: '/',
      });
    });

    it('parses 其他 type with counterparty / when merchant id follows on next lines', () => {
      const text = [
        '4200003106202605121867725259',
        '2026-05-12',
        '02:03:15',
        '转入零钱通-',
        '来自零钱',
        '其他 零钱 380.00 /',
        '18000073072605120562108684792687',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-05-12 02:03:15',
        type: '不计收支',
        amount: 380,
        counterparty: '/',
      });
    });

    it('still parses income transfer when payment method is /', () => {
      const text = [
        '1000050001202605120234991344877',
        '2026-05-12',
        '19:55:09',
        '转账 收入 / 30.00 少风哥 /',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-05-12 19:55:09',
        type: '收入',
        amount: 30,
        counterparty: '少风哥',
      });
    });
  });
});
