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

  describe('parseCmbTransactions', () => {
    const parse = (text: string) =>
      (service as unknown as { parseCmbTransactions(t: string): unknown[] }).parseCmbTransactions(text);

    it('parses CMB row and splits counterparty from transaction type', () => {
      const txs = parse('2025-06-15 CNY -45.00 18,099.10 银联快捷支付 微信转账');
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2025-06-15',
        type: '支出',
        amount: 45,
        counterparty: '微信转账',
      });
    });

    it('merges wrapped interest counterparty lines', () => {
      const text = [
        '2025-06-21 CNY 11.41 89.17 账户结息 应付利息-应付个人活期存款利',
        '息(自动计提)（新)',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '收入',
        amount: 11.41,
        counterparty: '应付利息-应付个人活期存款利息(自动计提)（新)',
      });
    });

    it('merges wrapped counterparty lines but not page footers', () => {
      const text = [
        '2025-07-16 CNY 800.00 927.54 银联代付 支付宝（中国）网络技术有限公',
        '司',
        '-- 1 of 3 --',
        '2/3',
        '记账日期 货币 交易金额 联机余额 交易摘要 对手信息',
        'Date Currency Transaction',
        'Amount Balance Transaction Type Counter Party',
        '2025-07-16 CNY -79.89 847.65 快捷支付 上海哈啰普惠科技有限公司',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0]).toMatchObject({
        type: '收入',
        amount: 800,
        counterparty: '支付宝（中国）网络技术有限公司',
      });
      expect(txs[0].counterparty).not.toContain('Date Currency');
      expect(txs[1]).toMatchObject({
        type: '支出',
        amount: 79.89,
        counterparty: '上海哈啰普惠科技有限公司',
      });
    });

    it('deduplicates repeated rows across page breaks', () => {
      const text = [
        '2025-10-18 CNY -20.80 1,202.59 快捷支付 小杨生煎企业管理发展（上海）',
        '有限公司',
        '-- 2 of 3 --',
        '3/3',
        '记账日期 货币 交易金额 联机余额 交易摘要 对手信息',
        '2025-10-18 CNY -20.80 1,202.59 快捷支付 小杨生煎企业管理发展（上海）',
        '有限公司',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
    });
  });

  describe('parseBocomTransactions', () => {
    const parse = (text: string) =>
      (service as unknown as { parseBocomTransactions(t: string): unknown[] }).parseBocomTransactions(text);

    it('parses BOCOM tab-separated transaction row', () => {
      const txs = parse('2025-06-28 网络支付 96.85\t96.40\t银联跨行代发 贷 Cr');
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2025-06-28',
        type: '收入',
        amount: 96.4,
        counterparty: '网络支付',
      });
    });

    it('parses BOCOM debit row', () => {
      const txs = parse('2025-06-28 手机银行 7.82\t31,800.00\t转账汇款 借 Dr');
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 31800,
        counterparty: '手机银行',
      });
    });

    it('merges multiline merchant name', () => {
      const text = [
        '2025-07-10 上海市松江区广富林街道鼓陶餐饮店',
        '（个体工 4.51\t3.70\t二维码支付 借 Dr',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 3.7,
        counterparty: '上海市松江区广富林街道鼓陶餐饮店（个体工',
      });
    });
  });

  describe('parsePdfText', () => {
    it('should reject when parsing invalid pdf buffer', async () => {
      await expect((service as any).parsePdfText(Buffer.from('invalid pdf'))).rejects.toThrow();
    });
  });
});
