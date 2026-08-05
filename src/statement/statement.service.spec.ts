import { Test, TestingModule } from '@nestjs/testing';
import { StatementService, Transaction } from './statement.service';
import { PrismaService } from '../prisma.service';
import { ShareCodeService } from '../share-code/share-code.service';
import * as fs from 'fs';

describe('StatementService', () => {
  let service: StatementService;
  let prisma: {
    queryRecord: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    wechatUser: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    statementUser: {
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      queryRecord: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      wechatUser: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      statementUser: {
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatementService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ShareCodeService,
          useValue: {
            createResultCode: jest.fn(),
            decode: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StatementService>(StatementService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processAndSaveFile idempotency', () => {
    beforeEach(() => {
      jest.spyOn(fs.promises, 'writeFile').mockResolvedValue();
      (service as any).parseAndUpdateRecord = jest
        .fn()
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('creates and charges once for a new upload request id', async () => {
      prisma.queryRecord.findUnique.mockResolvedValue(null);
      prisma.queryRecord.findFirst.mockResolvedValue(null);
      prisma.wechatUser.findUnique.mockResolvedValue({
        id: 7,
        monthlyCardExpiry: null,
      });
      prisma.wechatUser.updateMany.mockResolvedValue({ count: 1 });
      prisma.queryRecord.create.mockResolvedValue({ id: 42 });
      prisma.$transaction.mockImplementation((callback) => callback(prisma));

      await expect(
        service.processAndSaveFile(
          7,
          Buffer.from('statement'),
          '微信账单.pdf',
          'upload_request_001',
        ),
      ).resolves.toEqual({ id: 42, isDuplicate: false });

      expect(prisma.wechatUser.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.queryRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 7,
          uploadRequestId: 'upload_request_001',
          status: 'pending',
        }),
      });
    });

    it('returns the original record without charging for a replay', async () => {
      prisma.queryRecord.findUnique.mockResolvedValue({ id: 42, userId: 7 });

      await expect(
        service.processAndSaveFile(
          7,
          Buffer.from('statement'),
          '微信账单.pdf',
          'upload_request_001',
        ),
      ).resolves.toEqual({ id: 42, isDuplicate: false });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.wechatUser.updateMany).not.toHaveBeenCalled();
    });

    it('recovers the winning record after a concurrent unique conflict', async () => {
      prisma.queryRecord.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 43, userId: 7 });
      prisma.queryRecord.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.processAndSaveFile(
          7,
          Buffer.from('statement'),
          '微信账单.pdf',
          'upload_request_002',
        ),
      ).resolves.toEqual({ id: 43, isDuplicate: false });
    });

    it('creates separate records for different upload request ids', async () => {
      prisma.queryRecord.findUnique.mockResolvedValue(null);
      prisma.queryRecord.findFirst.mockResolvedValue(null);
      prisma.wechatUser.findUnique.mockResolvedValue({
        id: 7,
        monthlyCardExpiry: null,
      });
      prisma.wechatUser.updateMany.mockResolvedValue({ count: 1 });
      prisma.queryRecord.create
        .mockResolvedValueOnce({ id: 44 })
        .mockResolvedValueOnce({ id: 45 });
      prisma.$transaction.mockImplementation((callback) => callback(prisma));

      const first = await service.processAndSaveFile(
        7,
        Buffer.from('statement-a'),
        '微信账单-a.pdf',
        'upload_request_003',
      );
      const second = await service.processAndSaveFile(
        7,
        Buffer.from('statement-b'),
        '微信账单-b.pdf',
        'upload_request_004',
      );

      expect(first.id).toBe(44);
      expect(second.id).toBe(45);
      expect(prisma.wechatUser.updateMany).toHaveBeenCalledTimes(2);
    });

    it('reuses same-user done record within 3 days without charging', async () => {
      prisma.queryRecord.findUnique.mockResolvedValue(null);
      prisma.queryRecord.findFirst.mockResolvedValue({
        id: 99,
        userId: 7,
        status: 'done',
        summaryJson: { name: '测试' },
      });

      await expect(
        service.processAndSaveFile(
          7,
          Buffer.from('same-pdf'),
          '民生银行.pdf',
          'upload_request_same_user',
        ),
      ).resolves.toEqual({ id: 99, isDuplicate: true });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.wechatUser.updateMany).not.toHaveBeenCalled();
      expect((service as any).parseAndUpdateRecord).not.toHaveBeenCalled();
    });

    it('clones another user done result into a new record and skips parse', async () => {
      const cloneSource = {
        id: 10,
        source: '民生银行',
        summaryJson: {
          id: '10',
          name: '张三',
          source: '民生银行',
          startDate: '2025-05-26',
          endDate: '2026-05-26',
        },
        transactionsJson: [
          {
            date: '2025-05-27 17:49:33',
            month: '2025-05',
            type: '支出',
            amount: 2000,
            counterparty: '微信转账',
          },
        ],
        startDate: new Date('2025-05-26'),
        endDate: new Date('2026-05-26'),
        statementUserId: 55,
      };

      prisma.queryRecord.findUnique.mockResolvedValue(null);
      // 1) same-user lookup → null; 2) cross-user clone lookup → source;
      // 3) in-tx same-user → null; 4) in-tx refresh clone → source
      prisma.queryRecord.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(cloneSource)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(cloneSource);
      prisma.wechatUser.findUnique.mockResolvedValue({
        id: 8,
        monthlyCardExpiry: null,
      });
      prisma.wechatUser.updateMany.mockResolvedValue({ count: 1 });
      prisma.queryRecord.create.mockResolvedValue({ id: 100 });
      prisma.queryRecord.update.mockResolvedValue({ id: 100 });
      prisma.statementUser.update.mockResolvedValue({ id: 55 });
      prisma.$transaction.mockImplementation((callback) => callback(prisma));

      await expect(
        service.processAndSaveFile(
          8,
          Buffer.from('same-pdf'),
          '民生银行.pdf',
          'upload_request_other_user',
        ),
      ).resolves.toEqual({ id: 100, isDuplicate: false });

      expect(prisma.wechatUser.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.queryRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 8,
          status: 'done',
          source: '民生银行',
          statementUserId: 55,
          transactionsJson: cloneSource.transactionsJson,
        }),
      });
      expect(prisma.queryRecord.update).toHaveBeenCalledWith({
        where: { id: 100 },
        data: {
          summaryJson: expect.objectContaining({ id: '100', name: '张三' }),
        },
      });
      expect(prisma.statementUser.update).toHaveBeenCalledWith({
        where: { id: 55 },
        data: { queryCount: { increment: 1 } },
      });
      expect((service as any).parseAndUpdateRecord).not.toHaveBeenCalled();
    });
  });

  describe('parseWechatTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as { parseWechatTransactions(t: string): unknown[] }
      ).parseWechatTransactions(text);

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
        counterparty: '零钱通转出-到零钱',
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
        counterparty: '转入零钱通-来自零钱',
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
        bizType: '转账',
      });
    });

    it('extracts bizType and product for merchant consumption', () => {
      const text = [
        '4200003106202605121867725259',
        '2026-05-12',
        '02:03:15',
        '京东商城',
        '商户消费 支出 128.50 京东 /',
      ].join('\n');

      const txs = parse(text) as Transaction[];
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 128.5,
        bizType: '商户消费',
        product: '京东商城',
      });
    });

    it('extracts bizType for wechat red packet', () => {
      const text = [
        '1000050001202605120234991344877',
        '2026-05-12',
        '20:00:00',
        '微信红包（单发） 支出 8.88 发给张三 /',
      ].join('\n');

      const txs = parse(text) as Transaction[];
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 8.88,
        bizType: '微信红包（单发）',
      });
    });

    it('extracts bizType 其他 and product for lingqiantong', () => {
      const text = [
        '10001073012026051201337011622559',
        '2026-05-12',
        '01:22:34',
        '零钱通转出-',
        '到零钱',
        '其他 零钱通 5.00 / /',
      ].join('\n');

      const txs = parse(text) as Transaction[];
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '不计收支',
        amount: 5,
        bizType: '其他',
        product: '零钱通转出-到零钱',
        counterparty: '零钱通转出-到零钱',
      });
    });

    it('parses 其他 type with counterparty on separate line and amount line starts with amount (e.g. withdrawal)', () => {
      const text = [
        '53110001222015202603063520602141',
        '2026-03-06',
        '05:39:04',
        '零钱提现 其他 工商银行储',
        '蓄卡(1338)',
        '39.04 工商银行(13',
        '38)',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-03-06 05:39:04',
        type: '不计收支',
        amount: 39.04,
        counterparty: '零钱提现',
      });
    });

    it('parses 其他 type with counterparty and details on the same line as amount (e.g. Fenfu repayment)', () => {
      const text = [
        '53010002485131202602253285192059',
        '2026-02-25',
        '17:30:56',
        '分付还款 其他 零钱 337.00 分付 41800008316202602',
        '251894802832217',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-02-25 17:30:56',
        type: '不计收支',
        amount: 337,
        counterparty: '分付还款',
      });
    });

    it('still parses normal income transfer when transaction type is 其他 (e.g. activity reward / refund)', () => {
      const text = [
        '4200003106202604043039652035',
        '2026-04-04',
        '22:21:47',
        '其他 收入 / 0.68 活动奖励_09_20404197',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-04-04 22:21:47',
        type: '收入',
        amount: 0.68,
        counterparty: '活动奖励_09_20404197',
      });
    });
  });

  describe('detectSourceFromText', () => {
    const detect = (text: string) =>
      (
        service as unknown as { detectSourceFromText(t: string): string | null }
      ).detectSourceFromText(text);

    it('prefers CMB statement header over Alipay counterparty text', () => {
      const text = [
        '招商银行交易流水',
        'Transaction Statement of China Merchants Bank',
        '记账日期 货币 交易金额 联机余额 交易摘要 对手信息',
        '2025-07-16 CNY 800.00 927.54 银联代付 支付宝支付科技有限公司',
      ].join('\n');

      expect(detect(text)).toBe('招商银行');
    });

    it('detects Alipay from the statement title near the beginning', () => {
      const text = [
        '编号: 2026052000085004132820654681680069189554',
        '支付宝支付科技有限公司 交易流水证明',
        '兹证明:xx(证件号码:xxxx)在其支付宝账号xxxx中明细信息如下:',
      ].join('\n');

      expect(detect(text)).toBe('支付宝');
    });

    it('does not detect Alipay from counterparty text alone', () => {
      const text = [
        '未知账单',
        '记账日期 货币 交易金额 联机余额 交易摘要 对手信息',
        '2025-07-16 CNY 800.00 927.54 银联代付 支付宝支付科技有限公司',
      ].join('\n');

      expect(detect(text)).toBeNull();
    });

    it('detects rural commercial bank from the account detail title', () => {
      const text = [
        '广东顺德农村商业银行股份有限公司',
        '账户/卡明细信息',
        '账号/卡号：6223222020253306 户名：xxxx 币种：CNY',
      ].join('\n');

      expect(detect(text)).toBe('农商银行');
    });

    it('does not detect rural commercial bank from bank name alone', () => {
      const text = [
        '未知账单',
        '对方行 广东顺德农村商业银行股份有限公司',
        '2025-06-04 10:34:43 转账 -5000.00',
      ].join('\n');

      expect(detect(text)).toBeNull();
    });

    it('detects Agricultural Bank from footer title even when not in first lines', () => {
      const text = [
        '户名：张三 账户：6228481450433776818',
        '币种：人民币 汇钞标识：本币',
        '起止日期：20250720-20260719 电子流水号：26072012070207206305',
        '交易日期 交易时间 交易摘要 交易金额 本次余额 对手信息',
        '20250720 150904 转支 -20000.00 32410.15 陈美霞 Y091902039 掌上银行',
        '该交易明细因不可预测的非人控技术原因可能导致数据缺失，明细内容仅供参考',
        '中国农业银行账户活期交易明细清单',
        '第1页，共89页',
      ].join('\n');

      expect(detect(text)).toBe('农业银行');
    });

    it('does not confuse ICBC or rural commercial with Agricultural Bank', () => {
      expect(
        detect(
          [
            '中国工商银行借记账户历史明细',
            '户名：张三',
            '起止日期：2025-07-20 — 2026-07-19',
          ].join('\n'),
        ),
      ).toBe('工商银行');

      expect(
        detect(
          [
            '广东顺德农村商业银行股份有限公司',
            '账户/卡明细信息',
            '账号/卡号：6223222020253306 户名：xxxx 币种：CNY',
          ].join('\n'),
        ),
      ).toBe('农商银行');
    });

    it('detects China Construction Bank from the personal account title', () => {
      const text = [
        '中国建设银行个人活期账户全部交易明细',
        '卡号/账号:6215340300413250169 客户名称:黄梓聪 币别:人民币元 钞汇:钞 起止日期:20250723-20260723',
        '序号 摘要 交易日期 交易金额 账户余额 交易地点/附言 对方账号与户名',
        '2 消费 20250724 -298.00 740.77 *** Z******0014/*动漫',
      ].join('\n');

      expect(detect(text)).toBe('建设银行');
    });

    it('does not confuse CCB with Agricultural Bank or ICBC', () => {
      expect(
        detect(
          [
            '中国建设银行个人活期账户全部交易明细',
            '卡号/账号:6215340300413250169 客户名称:测试',
          ].join('\n'),
        ),
      ).toBe('建设银行');

      expect(
        detect(
          [
            '中国农业银行账户活期交易明细清单',
            '户名：张三 账户：6228481450433776818',
          ].join('\n'),
        ),
      ).toBe('农业银行');
    });

    it('detects Bank of China from the transaction list title', () => {
      const text = [
        '中国银行交易流水明细清单',
        '交易区间： 2026-02-01 至2026-07-31 客户姓名： 测试用户 页数: 1 /2',
        '借记卡号： 6217******1234 借方发生数： 78.40 贷方发生数： 75.00 行数: 2',
        '记账日期 记账时间 币别 金额 余额 交易名称 渠道 网点名称 附言',
        '2026-07-31 13:27:28 人民币 -3.00 1.56 网上快捷支付 银企对接 ------------------------- 财付通-测试商户',
      ].join('\n');

      expect(detect(text)).toBe('中国银行');
    });

    it('does not treat Alipay memo mentioning 中国银行 as BOC statement', () => {
      expect(
        detect(
          [
            '支付宝支付科技有限公司 交易流水证明',
            '交易时间 交易对方 金额',
            '2026-01-01 12:00:00 中国银行储蓄卡 100.00',
          ].join('\n'),
        ),
      ).toBe('支付宝');
    });

    it('detects Minsheng Bank from personal account statement header', () => {
      const text = [
        '个人账户对账单',
        '客户姓名:测试用户 客户账号:6226190302659135 产品名称:活期 币 种:人民币 钞汇标志:钞',
        '开户机构:中国民生银行股份有限公司广州珠江支行 账户账号:50000000000179924541 起止日期:2025/05/26-2026/05/26 筛选条件:全部 证件号码:320721198210010452',
        '凭证类型 凭证号码 交易时间 摘要 交易金额 账户余额 现转标志 交易渠道 交易机构 对方户名/账号 对方行名',
      ].join('\n');

      expect(detect(text)).toBe('民生银行');
    });

    it('does not treat Alipay memo mentioning 民生银行 as CMBc statement', () => {
      expect(
        detect(
          [
            '支付宝支付科技有限公司 交易流水证明',
            '交易时间 交易对方 金额',
            '2026-01-01 12:00:00 民生银行储蓄卡 100.00',
          ].join('\n'),
        ),
      ).toBe('支付宝');
    });

    it('detects SPDB from personal transaction statement title', () => {
      const text = [
        '上海浦东发展银行个人客户交易流水专用回单',
        'Transaction Statement of Shanghai Pudong Development Bank',
        '户名: 测试用户 账号: 6217921160538883 起止日期: 20250731-20260731',
      ].join('\n');

      expect(detect(text)).toBe('浦发银行');
    });

    it('does not treat Alipay memo mentioning 浦发银行 as SPDB statement', () => {
      expect(
        detect(
          [
            '支付宝支付科技有限公司 交易流水证明',
            '交易时间 交易对方 金额',
            '2026-01-01 12:00:00 浦发银行储蓄卡 100.00',
          ].join('\n'),
        ),
      ).toBe('支付宝');
    });
  });

  describe('parseCmbTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as { parseCmbTransactions(t: string): Transaction[] }
      ).parseCmbTransactions(text);

    it('parses CMB row and splits counterparty from transaction type', () => {
      const txs = parse(
        '2025-06-15 CNY -45.00 18,099.10 银联快捷支付 微信转账',
      );
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
      (
        service as unknown as { parseBocomTransactions(t: string): unknown[] }
      ).parseBocomTransactions(text);

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

  describe('parseAbcTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as { parseAbcTransactions(t: string): Transaction[] }
      ).parseAbcTransactions(text);

    it('parses single-line debit transfer', () => {
      const txs = parse(
        '20250720 150904 转支 -20000.00 32410.15 陈美霞 Y091902039 掌上银行',
      );
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2025-07-20 15:09:04',
        month: '2025-07',
        type: '支出',
        amount: 20000,
        counterparty: '陈美霞',
      });
    });

    it('parses interest rows without transaction time', () => {
      const txs = parse(
        '20250921 结息 +1.89 4276.70 -- 1590048610 掌上银行',
      );
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2025-09-21',
        type: '收入',
        amount: 1.89,
        counterparty: '结息',
      });
    });

    it('merges wrapped counterparty lines but not page footers', () => {
      const text = [
        '20250720 013149 易宝支付 -1088.98 52465.06 海南宜信普惠小额',
        '贷款有限公司 W004669150 电子商务 UA0720013149036866海南宜信普惠小额贷款有限公司',
        '中国农业银行账户活期交易明细清单',
        '第1页，共89页',
        '户名：钟立华 账户：6228481450433776818',
        '20250720 150904 转支 -20000.00 32410.15 陈美霞 Y091902039 掌上银行',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 1088.98,
        counterparty: '海南宜信普惠小额贷款有限公司',
      });
      expect(txs[0].counterparty).not.toContain('中国农业银行');
      expect(txs[1]).toMatchObject({
        amount: 20000,
        counterparty: '陈美霞',
      });
    });

    it('deduplicates repeated rows across page breaks', () => {
      const text = [
        '20250720 150904 转支 -20000.00 32410.15 陈美霞 Y091902039 掌上银行',
        '-- 2 of 89 --',
        '中国农业银行账户活期交易明细清单',
        '交易日期 交易时间 交易摘要 交易金额 本次余额 对手信息',
        '20250720 150904 转支 -20000.00 32410.15 陈美霞 Y091902039 掌上银行',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
    });
  });

  describe('parseCcbTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as { parseCcbTransactions(t: string): Transaction[] }
      ).parseCcbTransactions(text);

    it('parses expense and income rows with comma amounts', () => {
      const text = [
        '2 消费 20250724 -298.00 740.77 *** Z******0014/*动漫',
        '43 支付机构提现 20250801 466.07 7,480.08 *** 617995503/黄梓聪',
        '51 还款 20250803 -7,432.60 2,012.32 *** Z******0010/*梓聪',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(3);
      expect(txs[0]).toMatchObject({
        date: '2025-07-24',
        month: '2025-07',
        type: '支出',
        amount: 298,
        counterparty: '*动漫',
      });
      expect(txs[1]).toMatchObject({
        date: '2025-08-01',
        type: '收入',
        amount: 466.07,
        counterparty: '黄梓聪',
      });
      expect(txs[2]).toMatchObject({
        type: '支出',
        amount: 7432.6,
        counterparty: '*梓聪',
      });
    });

    it('uses summary when counterparty is missing', () => {
      const txs = parse(
        [
          '202 利息存入 20250921 0.36 8,423.01',
          '417 收费 20251224 -15.00 252.85 ***',
          '462 ATM存款 20260217 1,000.00 1,383.01 ***',
        ].join('\n'),
      );
      expect(txs).toHaveLength(3);
      expect(txs[0]).toMatchObject({
        type: '收入',
        amount: 0.36,
        counterparty: '利息存入',
      });
      expect(txs[1]).toMatchObject({
        type: '支出',
        amount: 15,
        counterparty: '收费',
      });
      expect(txs[2]).toMatchObject({
        type: '收入',
        amount: 1000,
        counterparty: 'ATM存款',
      });
    });

    it('merges wrapped summary and counterparty lines', () => {
      const text = [
        '1 人民币卡消费',
        '款 20250723 135.66 1,038.77 *** 029100330000032400000/待清算商户',
        '款项440660801',
        '297 保险费（跨行',
        '） 20251109 -14,780.15 13,109.89 *** 1202021719800464074/中国人民人寿',
        '保险股份有限公司',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0]).toMatchObject({
        type: '收入',
        amount: 135.66,
        counterparty: '待清算商户款项440660801',
      });
      expect(txs[1]).toMatchObject({
        type: '支出',
        amount: 14780.15,
        counterparty: '中国人民人寿保险股份有限公司',
      });
    });

    it('skips page headers/footers and keeps distinct same-day charges', () => {
      const text = [
        '中国建设银行个人活期账户全部交易明细',
        '卡号/账号:6215340300413250169 客户名称:黄梓聪 币别:人民币元 钞汇:钞 起止日期:20250723-20260723',
        '当前时间段收支金额合计：人民币元； 总支出：1,165,733.89 总收入：1,164,870.20',
        '序号 摘要 交易日期 交易金额 账户余额 交易地点/附言 对方账号与户名',
        '85 充值 20250812 -1,200.00 16,156.07 *** Z******0010/**转账',
        '生成时间：2026-07-23 18:09:23',
        '温馨提示：以上明细为查询周期内全量明细',
        '- 第1页/共27页 -',
        '-- 1 of 27 --',
        '中国建设银行个人活期账户全部交易明细',
        '序号 摘要 交易日期 交易金额 账户余额 交易地点/附言 对方账号与户名',
        '86 充值 20250812 -1,200.00 14,956.07 *** Z******0010/**转账',
        '3 消费 20250724 -192.00 1,107.37 *** Z******0010/*哲菁',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(3);
      expect(txs[0]).toMatchObject({ amount: 1200, counterparty: '**转账' });
      expect(txs[1]).toMatchObject({ amount: 1200, counterparty: '**转账' });
      expect(txs[2].counterparty).toBe('*哲菁');
    });
  });

  describe('parseBocTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as { parseBocTransactions(t: string): Transaction[] }
      ).parseBocTransactions(text);

    it('parses expense and income rows with comma amounts and signed amounts', () => {
      const text = [
        '2026-07-31 13:27:28 人民币 -3.00 1.56 网上快捷支付 银企对接 ------------------------- 财付通-测试商户',
        '2026-07-26 18:15:47 人民币 1,500.50 1,501.96 网上快捷提现 银企对接 ------------------------- --微信零钱提现-0001',
        '2026-05-03 15:14:40 人民币 -3,000.00 40.48 跨行转账 手机银行 ------------------------- -------------',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(3);
      expect(txs[0]).toMatchObject({
        date: '2026-07-31 13:27:28',
        month: '2026-07',
        type: '支出',
        amount: 3,
        counterparty: '财付通-测试商户',
      });
      expect(txs[1]).toMatchObject({
        type: '收入',
        amount: 1500.5,
        counterparty: '--微信零钱提现-0001',
      });
      expect(txs[2]).toMatchObject({
        type: '支出',
        amount: 3000,
        counterparty: '跨行转账',
      });
    });

    it('uses transaction name when memo is a dash placeholder', () => {
      const txs = parse(
        '2026-07-31 12:02:46 人民币 15.00 16.56 数字人民币兑回 网上银行 ------------------------- -------------',
      );
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '收入',
        amount: 15,
        counterparty: '数字人民币兑回',
      });
    });

    it('merges wrapped memo lines', () => {
      const text = [
        '2026-07-31 13:27:28 人民币 -3.00 1.56 网上快捷支付 银企对接 ------------------------- 财付通-广东省大沐新能源科技',
        '有限公司',
        '2026-07-26 18:54:37 人民币 -5.92 48.72 网上快捷支付 银企对接 ------------------------- 美团支付(钱袋宝)-美团AppBing',
        'o手打柠檬茶(怀德店)',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0].counterparty).toBe('财付通-广东省大沐新能源科技有限公司');
      expect(txs[1].counterparty).toBe(
        '美团支付(钱袋宝)-美团AppBingo手打柠檬茶(怀德店)',
      );
    });

    it('skips page headers/footers', () => {
      const text = [
        '中国银行交易流水明细清单',
        '交易区间： 2026-02-01 至2026-07-31 客户姓名： 测试用户 页数: 1 /2',
        '借记卡号： 6217******1234 借方发生数： 78.40 贷方发生数： 75.00 行数: 2',
        '账号： 7159******3299 按收支筛选： 全部 按币种筛选： 全部 打印时间： 2026/07/31 20:04:29',
        '记账日期 记账时间 币别 金额 余额 交易名称 渠道 网点名称 附言',
        '2026-07-31 13:27:28 人民币 -3.00 1.56 网上快捷支付 银企对接 ------------------------- 财付通-测试A',
        '温馨提示: 1.记账日期/时间为系统进行记账处理的日期/时间,可能与实际交易提交时间存在差异。',
        '第 1 页/共 2 页',
        '--------------------END--------------------',
        '中国银行交易流水明细清单',
        '记账日期 记账时间 币别 金额 余额 交易名称 渠道 网点名称 附言',
        '2026-07-30 19:08:01 人民币 10.00 19.56 数字人民币兑回 网上银行 ------------------------- -------------',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0].counterparty).toBe('财付通-测试A');
      expect(txs[1]).toMatchObject({
        amount: 10,
        counterparty: '数字人民币兑回',
      });
    });
  });

  describe('parseCmbcTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as {
          parseCmbcTransactions(t: string): Transaction[];
        }
      ).parseCmbcTransactions(text);

    it('parses expense and income rows with comma amounts and signed amounts', () => {
      const text = [
        '卡 6226190302',
        '659135 2025/05/27 17:49:33 财付通-快捷支付-微信转账 -2,000.00 393.12 转账 跨行支付 0001 微信转账/1000050201 财付通',
        '卡 6226190302',
        '659135 2025/05/28 17:49:35 财付通 退款 2,000.00 2,393.12 转账 跨行支付 0001 微信转账/1000050201 财付通',
        '卡 6226190302',
        '659135 2025/06/01 20:34:52 网上支付跨行清算系统汇款 50,000.00 52,284.32 转账 跨行支付 0001 肖自强/6214620421001061869 广发银行股份有限公司',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(3);
      expect(txs[0]).toMatchObject({
        date: '2025-05-27 17:49:33',
        month: '2025-05',
        type: '支出',
        amount: 2000,
        counterparty: '微信转账',
      });
      expect(txs[1]).toMatchObject({
        type: '收入',
        amount: 2000,
        counterparty: '微信转账',
      });
      expect(txs[2]).toMatchObject({
        type: '收入',
        amount: 50000,
        counterparty: '肖自强',
      });
    });

    it('merges wrapped counterparty lines with spaced slash', () => {
      const text = [
        '卡 6226190302',
        '659135 2025/06/01 16:43:36 抖音支付-快捷支付-抖音月付 -108.80 2,284.32 转账 跨行支付 0001 深圳市中融小额贷款有限公司',
        '/800075500100007 抖音支付',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 108.8,
        counterparty: '深圳市中融小额贷款有限公司',
      });
    });

    it('parses interest rows without card prefix', () => {
      const txs = parse('2025/06/21 00:45:34 结息 3.64 53,004.86 转账');
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2025-06-21 00:45:34',
        type: '收入',
        amount: 3.64,
        counterparty: '结息',
      });
    });

    it('skips page headers/footers', () => {
      const text = [
        '个人账户对账单',
        '客户姓名:测试用户 客户账号:6226190302659135 产品名称:活期 币 种:人民币 钞汇标志:钞',
        '开户机构:中国民生银行股份有限公司广州珠江支行 账户账号:50000000000179924541 起止日期:2025/05/26-2026/05/26 筛选条件:全部 证件号码:320721198210010452',
        '凭证类型 凭证号码 交易时间 摘要 交易金额 账户余额 现转标志 交易渠道 交易机构 对方户名/账号 对方行名',
        '卡 6226190302',
        '659135 2025/05/27 17:49:33 财付通-快捷支付-微信转账 -2,000.00 393.12 转账 跨行支付 0001 微信转账/1000050201 财付通',
        '_______________________________________________________________________________',
        '打印渠道:手机银行 打印柜员:1511117102 打印时间:2026-05-26 08:54:10 第 1 页 / 共 37 页',
        '-- 2 of 37 --',
        '个人账户对账单',
        '客户姓名:测试用户 客户账号:6226190302659135 产品名称:活期 币 种:人民币 钞汇标志:钞',
        '开户机构:中国民生银行股份有限公司广州珠江支行 账户账号:50000000000179924541 起止日期:2025/05/26-2026/05/26 筛选条件:全部 证件号码:320721198210010452',
        '凭证类型 凭证号码 交易时间 摘要 交易金额 账户余额 现转标志 交易渠道 交易机构 对方户名/账号 对方行名',
        '卡 6226190302',
        '659135 2025/05/28 17:49:35 财付通 退款 2,000.00 2,393.12 转账 跨行支付 0001 微信转账/1000050201 财付通',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0].counterparty).toBe('微信转账');
      expect(txs[1]).toMatchObject({
        type: '收入',
        amount: 2000,
        counterparty: '微信转账',
      });
    });
  });

  describe('parseSpdbTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as {
          parseSpdbTransactions(t: string): Transaction[];
        }
      ).parseSpdbTransactions(text);

    it('parses expense and income with wrapped account and signed amounts', () => {
      const text = [
        '20250731 054626 62179211605',
        '38883',
        '互联汇出',
        '25073100015',
        '298',
        '-4000.00 24790.83 *杰 622848044',
        '8375*****',
        '*',
        '20250731 173046 62179211605',
        '38883',
        '财付通-微信',
        '零钱提现',
        '9990.01 13238.51 **琪 1071*****',
        '*',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0]).toMatchObject({
        date: '2025-07-31 05:46:26',
        month: '2025-07',
        type: '支出',
        amount: 4000,
        counterparty: '*杰',
      });
      expect(txs[1]).toMatchObject({
        type: '收入',
        amount: 9990.01,
        counterparty: '**琪',
      });
    });

    it('merges wrapped Chinese tx names and counterparty masks', () => {
      const text = [
        '20250731 162845 62179211605',
        '38883',
        '网上支付-支',
        '付宝',
        '-200.00 16590.83 **龙 208840210',
        '64560****',
        '**',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 200,
        counterparty: '**龙',
      });
    });

    it('parses interest rows without swallowing leading digits into account', () => {
      const text = [
        '20250921 042658 62179211605',
        '38883',
        '25季息',
        '17.86 33301.10 ********',
        '****息 196101325',
        '00******',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2025-09-21 04:26:58',
        type: '收入',
        amount: 17.86,
        counterparty: '************息',
      });
    });

    it('fixes wrapped balance decimals and skips page chrome', () => {
      const text = [
        '上海浦东发展银行个人客户交易流水专用回单',
        '户名: 测试用户 账号: 6217921160538883 起止日期: 20250731-20260731',
        '交易日期',
        'Date',
        '20250829 085849 62179211605',
        '38883',
        '汇入外',
        'LZ250829000',
        '40862',
        '4000000.00 4000857.',
        '26 **萍 621768051',
        '4******',
        '****',
        '第1页/共154页，Page 1 of 154',
        '-- 2 of 154 --',
        '20250829 105421 62179211605',
        '38883',
        '网上支付-财',
        '付通',
        '-149.00 4000708.',
        '26 ****手 1593*****',
        '*',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0]).toMatchObject({
        type: '收入',
        amount: 4000000,
        counterparty: '**萍',
      });
      expect(txs[1]).toMatchObject({
        type: '支出',
        amount: 149,
        counterparty: '****手',
      });
    });
  });

  describe('parsePdfText', () => {
    it('should reject when parsing invalid pdf buffer', async () => {
      await expect(
        (service as any).parsePdfText(Buffer.from('invalid pdf')),
      ).rejects.toThrow();
    });
  });

  describe('parseCsvFile', () => {
    const parse = (buffer: Buffer) => (service as any).parseCsvFile(buffer);

    it('rejects Alipay Cashbook with BadRequestException', async () => {
      const cashbookContent = [
        '特别提示：',
        '1.本记账单内容可表明支付宝受理了相应记账明细申请',
        '记录时间,分类,收支类型,金额,备注,账户,来源,标签',
        '2026-06-28 11:19:26,转账,支出,5000.00,感谢老姐的照顾-小梅(梅昙),招商银行,账单同步',
      ].join('\n');

      const buffer = Buffer.from(cashbookContent, 'utf-8');
      await expect(parse(buffer)).rejects.toThrow(
        '暂不支持解析支付宝记账本流水',
      );
    });

    it('parses standard Alipay Transaction Details CSV', async () => {
      const csvContent = [
        '------------------------------------------------------------------------------------',
        '导出信息：',
        '姓名：梅XX',
        '支付宝账户：19232048628',
        '起始时间：[2026-04-01 00:00:00]    终止时间：[2026-07-01 23:59:59]',
        '------------------------支付宝支付科技有限公司  电子客户回单------------------------',
        '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
        '2026-06-28 11:19:26,转账红包,小梅(梅XX),gif***@qq.com,感谢梅XX的照顾,支出,"5,000.00",招商银行储蓄卡(8759),交易成功,20260628200040011100680018462283	,	,,',
        '2026-06-27 06:40:18,日用百货,念***w,183******45,RTX4090跑包,支出,19.89,网商银行储蓄卡(6617),支付成功,2026062723001154681441324980	,	,,',
      ].join('\n');

      const buffer = Buffer.from(csvContent, 'utf-8');
      const res = await parse(buffer);

      expect(res.summary).toMatchObject({
        source: '支付宝',
        name: '梅XX',
        phoneNumber: '19232048628',
        startDate: '2026-04-01',
        endDate: '2026-07-01',
        totalIncome: 0,
        totalExpenditure: 5019.89,
        selfIncome: 0,
        selfExpenditure: 5000,
      });

      expect(res.transactions).toHaveLength(2);
      expect(res.transactions[0]).toMatchObject({
        date: '2026-06-28 11:19:26',
        type: '支出',
        amount: 5000,
        counterparty: '小梅(梅XX)',
        bizType: '转账红包',
        product: '感谢梅XX的照顾',
      });
      expect(res.transactions[1]).toMatchObject({
        date: '2026-06-27 06:40:18',
        type: '支出',
        amount: 19.89,
        counterparty: '念***w',
        bizType: '日用百货',
        product: 'RTX4090跑包',
      });
    });

    it('falls back to 匿名 when name is missing', async () => {
      const csvContent = [
        '------------------------------------------------------------------------------------',
        '导出信息：',
        '起始时间：[2026-04-01 00:00:00]    终止时间：[2026-07-01 23:59:59]',
        '------------------------支付宝支付科技有限公司  电子客户回单------------------------',
        '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
        '2026-06-27 06:40:18,日用百货,念***w,183******45,RTX4090跑包,支出,19.89,网商银行储蓄卡(6617),支付成功,2026062723001154681441324980	,	,,',
      ].join('\n');

      const buffer = Buffer.from(csvContent, 'utf-8');
      const res = await parse(buffer);

      expect(res.summary.name).toBe('匿名');
      expect(res.summary.phoneNumber).toBe('');
    });

    it('parses Alipay Electronic Customer Receipt text format correctly', async () => {
      const textContent = [
        '------------------------------------------------------------------------------------',
        '导出信息：',
        '姓名：曾海峰',
        '支付宝账户：18275370949',
        '起始时间：[2025-07-02 00:00:00] 终止时间：[2026-07-01 23:59:59]',
        '共2笔记录',
        '------------------------支付宝支付科技有限公司 电子客户回单------------------------',
        '交易时间 交易分类 交易对方 对方账号 商品说明 收/支 金额',
        '######### 餐饮美食 luckincoffee zhi***@lkcoffe 订单付款 支出 15.8',
        '######### 退款 钉钉红包 / 钉钉红包退款 不计收支 26',
        '收/付款方式 交易状态 交易订单号 商家订单号 备注',
        '招商银行储蓄卡交易成功 202607012300SXA1O4269626751',
        '招商银行储蓄卡退款成功 20260701220020260701141724208001000',
      ].join('\n');

      const parsedSource = service.detectSourceFromText(textContent);
      expect(parsedSource).toBe('支付宝');

      const parsedData = (service as any).extractData(textContent, '支付宝');

      expect(parsedData.summary.name).toBe('曾海峰');
      expect(parsedData.summary.phoneNumber).toBe('18275370949');
      expect(parsedData.transactions).toHaveLength(2);
      expect(parsedData.transactions[0]).toMatchObject({
        type: '支出',
        amount: 15.8,
        counterparty: 'luckincoffee',
        date: '2026-07-01 23:00:00',
      });
      expect(parsedData.transactions[1]).toMatchObject({
        type: '不计收支',
        amount: 26,
        counterparty: '钉钉红包',
        date: '2026-07-01 22:00:00',
      });
    });
  });

  describe('parseXlsxFile WeChat 交易明细证明', () => {
    const ExcelJS = require('exceljs');

    async function buildProofWorkbookBuffer(): Promise<Buffer> {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Table 1');
      sheet.addRow(['编号：20260725175333156686382462058512']);
      sheet.addRow([
        '微信支付交易明细证明\n兹证明：王钻英（居民身份证：441324197812103649），在其微信号：wz103649中的交易明细信息如下：\n币种：人民币 / 单位：元',
      ]);
      sheet.addRow([
        '交易明细对应时间段',
        '2025-07-25 00:00:00 至 2026-07-25 17:53:33',
      ]);
      sheet.addRow(['具体交易明细']);
      sheet.addRow([
        '交易单号',
        '交易时间',
        '交易类型',
        '收/支/其他',
        '交易方式',
        '金额(元)',
        '交易对方',
        '商户单号',
      ]);
      // Mimic real proof files: most cells are Excel richText with embedded newlines
      const rt = (text: string) => ({
        richText: [{ font: { size: 9, name: 'PMingLiU' }, text }],
      });
      sheet.addRow([
        rt('530100033650962026072541\n69749808'),
        rt('2026-07-25\n17:14:15'),
        rt('转账'),
        rt('支出'),
        rt('零钱'),
        10000,
        rt('文 (文)'),
        rt('10000500012026072\n50333957150776'),
      ]);
      sheet.addRow([
        rt('100005000120260725033435\n3140491'),
        rt('2026-07-25\n17:14:01'),
        rt('转账'),
        rt('收入'),
        rt('/'),
        10000,
        rt('女仔 (奕心)'),
        rt('/'),
      ]);
      sheet.addRow([
        rt('110260723100057311867153\n420516'),
        rt('2026-07-23\n23:24:27'),
        rt('零钱充值'),
        rt('其他'),
        rt('广东华润银行储蓄卡(3280)'),
        20,
        rt('广东华润银行(3280)'),
        rt('/'),
      ]);
      sheet.addRow([]);
      sheet.addRow([
        rt('420000315220260724444250\n4132'),
        rt('2026-07-24\n20:10:04'),
        rt('商户消费'),
        rt('支出'),
        rt('零钱'),
        6,
        rt('八借充电'),
        rt('Mnb9527QVVC9Suh'),
      ]);
      sheet.addRow(['说明：']);
      sheet.addRow([
        '1. 本《微信支付交易明细证明》仅证明：在用户选择的交易类型和时间段内...',
      ]);
      sheet.addRow(['财付通支付科技有限公司\n盖章']);

      const arrayBuffer = await workbook.xlsx.writeBuffer();
      return Buffer.from(arrayBuffer);
    }

    it('parses proof xlsx metadata, directions, newline dates, and skips footer', async () => {
      const buffer = await buildProofWorkbookBuffer();
      const res = await (service as any).parseXlsxFile(buffer);

      expect(res.summary.source).toBe('微信');
      expect(res.summary.name).toBe('王钻英');
      expect(res.summary.idNumber).toBe('441324197812103649');
      expect(res.summary.startDate).toBe('2025-07-25');
      expect(res.summary.endDate).toBe('2026-07-25');
      expect(res.transactions).toHaveLength(4);

      // newest first
      expect(res.transactions[0]).toMatchObject({
        date: '2026-07-25 17:14:15',
        type: '支出',
        amount: 10000,
        counterparty: '文 (文)',
        bizType: '转账',
        product: '',
      });
      expect(res.transactions[1]).toMatchObject({
        date: '2026-07-25 17:14:01',
        type: '收入',
        amount: 10000,
        counterparty: '女仔 (奕心)',
        bizType: '转账',
      });
      expect(res.transactions[2]).toMatchObject({
        date: '2026-07-24 20:10:04',
        type: '支出',
        amount: 6,
        counterparty: '八借充电',
        bizType: '商户消费',
      });
      expect(res.transactions[3]).toMatchObject({
        date: '2026-07-23 23:24:27',
        type: '不计收支',
        amount: 20,
        counterparty: '广东华润银行(3280)',
        bizType: '零钱充值',
      });

      expect(res.summary.totalIncome).toBe(10000);
      expect(res.summary.totalExpenditure).toBe(10006);
    });

    it('still parses standard WeChat bill-export xlsx', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.addRow(['微信支付账单明细']);
      sheet.addRow(['微信昵称：[SuperAlan]']);
      sheet.addRow([
        '起始时间：[2026-04-01 00:00:00] 终止时间：[2026-07-01 13:26:48]',
      ]);
      sheet.addRow([
        '交易时间',
        '交易类型',
        '交易对方',
        '商品',
        '收/支',
        '金额(元)',
        '支付方式',
        '当前状态',
        '交易单号',
        '商户单号',
        '备注',
      ]);
      sheet.addRow([
        new Date(Date.UTC(2026, 5, 30, 5, 50, 25)), // +8h -> 2026-06-30 13:50:25
        '商户消费',
        '农家味小湘厨鸣乐店',
        '农家味小湘厨鸣乐店-order',
        '支出',
        19.51,
        '零钱通',
        '支付成功',
        '4200003114202606304979873207',
        '83620260630665569479',
        '/',
      ]);
      sheet.addRow([
        new Date(Date.UTC(2026, 5, 30, 0, 32, 40)), // +8h -> 2026-06-30 08:32:40
        '转账',
        '张三',
        '/',
        '收入',
        100,
        '零钱',
        '已收钱',
        '1000050001',
        '/',
        '/',
      ]);

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const res = await (service as any).parseXlsxFile(buffer);

      expect(res.summary.name).toBe('SuperAlan');
      expect(res.summary.startDate).toBe('2026-04-01');
      expect(res.summary.endDate).toBe('2026-07-01');
      expect(res.transactions).toHaveLength(2);
      expect(res.transactions[0]).toMatchObject({
        date: '2026-06-30 13:50:25',
        type: '支出',
        amount: 19.51,
        counterparty: '农家味小湘厨鸣乐店',
        bizType: '商户消费',
        product: '农家味小湘厨鸣乐店-order',
      });
      expect(res.transactions[1]).toMatchObject({
        date: '2026-06-30 08:32:40',
        type: '收入',
        amount: 100,
        counterparty: '张三',
      });
    });
  });
});
