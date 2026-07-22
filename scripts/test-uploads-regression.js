const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Resolve StatementService from dist folder
let StatementService;
const possiblePaths = [
  '../dist/src/statement/statement.service.js',
  './dist/src/statement/statement.service.js',
  '../dist/statement/statement.service.js',
  './dist/statement/statement.service.js',
];

for (const p of possiblePaths) {
  try {
    StatementService = require(p).StatementService;
    break;
  } catch {}
}

if (!StatementService) {
  console.error('\n❌ 错误: 未找到编译后的 StatementService 模块，请先运行: npm run build\n');
  process.exit(1);
}

async function main() {
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    console.error(`❌ uploads 目录不存在: ${uploadsDir}`);
    process.exit(1);
  }

  // Collect test files (files starting with "test")
  const allFiles = fs.readdirSync(uploadsDir);
  const testFiles = allFiles.filter((file) => file.toLowerCase().startsWith('test'));

  console.log('\n=============================================================');
  console.log('         🚀 账单解析回归测试工具 (Uploads Regressions)         ');
  console.log('=============================================================');
  console.log(`目标目录: ${uploadsDir}`);
  console.log(`符合条件的文件 (test*): ${testFiles.length} 个\n`);

  if (testFiles.length === 0) {
    console.log('⚠️ 没在 uploads 目录找到任何以 test 开头的文件。');
    process.exit(0);
  }

  const service = new StatementService({});
  if (service.onModuleInit) {
    service.onModuleInit();
  }

  let passCount = 0;
  let failCount = 0;
  const results = [];

  for (let i = 0; i < testFiles.length; i++) {
    const fileName = testFiles[i];
    const filePath = path.join(uploadsDir, fileName);
    const ext = path.extname(fileName).toLowerCase();
    const startTime = performance.now();

    let success = false;
    let errorMsg = '';
    let parsedData = null;

    try {
      const buffer = fs.readFileSync(filePath);

      if (ext === '.xlsx' || ext === '.xls') {
        parsedData = await service.parseXlsxFile(buffer);
      } else if (ext === '.csv') {
        parsedData = await service.parseCsvFile(buffer);
      } else {
        const text = await service.parsePdfText(buffer);
        const source = service.detectSourceFromText(text);
        if (!source) {
          throw new Error('未识别账单来源 (Unrecognized statement source)');
        }
        parsedData = service.extractData(text, source);
      }

      if (!parsedData || !parsedData.summary) {
        throw new Error('解析结果缺少 summary 摘要信息');
      }

      if (!Array.isArray(parsedData.transactions)) {
        throw new Error('解析结果 transactions 格式非法');
      }

      if (parsedData.transactions.length === 0) {
        throw new Error('解析提取交易笔数为 0 笔');
      }

      success = true;
      passCount++;
    } catch (err) {
      failCount++;
      errorMsg = err.message || String(err);
    }

    const duration = (performance.now() - startTime).toFixed(1);

    results.push({
      index: i + 1,
      fileName,
      ext,
      success,
      errorMsg,
      source: parsedData?.summary?.source || '未知',
      name: parsedData?.summary?.name || '-',
      txCount: parsedData?.transactions?.length || 0,
      income: parsedData?.summary?.totalIncome ?? 0,
      expense: parsedData?.summary?.totalExpenditure ?? 0,
      dateRange: parsedData?.summary?.startDate && parsedData?.summary?.endDate
        ? `${parsedData.summary.startDate} ~ ${parsedData.summary.endDate}`
        : '-',
      duration: `${duration}ms`,
    });
  }

  // Print Detail Summary
  console.log(
    '------------------------------------------------------------------------------------------------------------------------'
  );
  console.log(
    '序号 | 状态 | 来源渠道 | 账单人 | 笔数 | 时间范围 | 收入 | 支出 | 耗时 | 文件名'
  );
  console.log(
    '------------------------------------------------------------------------------------------------------------------------'
  );

  for (const r of results) {
    const statusTag = r.success ? '✅ PASS' : '❌ FAIL';
    console.log(
      `[${r.index}] ${statusTag} | ${r.source.padEnd(6)} | ${r.name.padEnd(6)} | ${String(
        r.txCount
      ).padStart(5)}笔 | ${r.dateRange} | +${r.income} | -${r.expense} | ${r.duration.padStart(
        6
      )} | ${r.fileName}`
    );
    if (!r.success) {
      console.log(`    ↳ ❌ 失败原因: ${r.errorMsg}`);
    }
  }

  console.log(
    '------------------------------------------------------------------------------------------------------------------------\n'
  );
  console.log(`📊 测试汇总: 总数 ${testFiles.length} 个, 通过 ${passCount} 个, 失败 ${failCount} 个`);

  if (failCount > 0) {
    console.error(`\n❌ 回归测试未全部通过，有 ${failCount} 个文件解析失败！\n`);
    process.exit(1);
  } else {
    console.log(`\n🎉 所有以 test 开头的账单文件解析全部通过！系统解析逻辑正常！\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('运行过程抛出未知异常:', err);
  process.exit(1);
});
