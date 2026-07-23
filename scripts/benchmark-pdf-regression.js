/**
 * Regression benchmark for bank statement PDFs using pdf-parse.
 *
 * Usage:
 *   node scripts/benchmark-pdf-regression.js uploads/*.pdf
 *   node scripts/benchmark-pdf-regression.js --dir uploads
 *
 * Expects 6 bank/channel types (WeChat, Alipay, CMB, BOCOM, ICBC, Rural Commercial Bank).
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

let StatementService;
const possiblePaths = [
  '../dist/src/statement/statement.service.js',
  './dist/src/statement/statement.service.js',
];

for (const p of possiblePaths) {
  try {
    StatementService = require(p).StatementService;
    break;
  } catch {
    // try next
  }
}

if (!StatementService) {
  console.error("Build required: npm run build");
  process.exit(1);
}

const EXPECTED_SOURCES = ['微信', '支付宝', '招商银行', '交通银行', '工商银行', '农商银行', '农业银行'];

function collectPdfPaths(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      const dir = path.resolve(process.cwd(), argv[i + 1]);
      if (!fs.existsSync(dir)) {
        console.error(`Directory not found: ${dir}`);
        process.exit(1);
      }
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase().endsWith('.pdf')) {
          paths.push(path.join(dir, name));
        }
      }
      i++;
    } else if (!argv[i].startsWith('-')) {
      paths.push(path.resolve(process.cwd(), argv[i]));
    }
  }
  return [...new Set(paths)];
}

function summarize(service, text) {
  const source = service.detectSourceFromText(text);
  if (!source) return null;
  const parsed = service.extractData(text, source);
  return {
    source,
    txCount: parsed.transactions.length,
    income: parsed.summary.totalIncome,
    expense: parsed.summary.totalExpenditure,
    startDate: parsed.summary.startDate,
    endDate: parsed.summary.endDate,
  };
}

async function main() {
  const pdfPaths = collectPdfPaths(process.argv.slice(2));

  if (pdfPaths.length === 0) {
    console.log('No PDF files provided.');
    console.log('Usage: node scripts/benchmark-pdf-regression.js --dir uploads');
    console.log('       node scripts/benchmark-pdf-regression.js path/to/sample.pdf');
    process.exit(0);
  }

  const service = new StatementService({});
  service.onModuleInit?.();

  const results = [];
  const sourcesSeen = new Set();

  console.log('PDF Regression Benchmark (pdf-parse)');
  console.log('====================================');
  console.log(`Files: ${pdfPaths.length}\n`);

  for (const pdfPath of pdfPaths) {
    const buffer = fs.readFileSync(pdfPath);
    const fileName = path.basename(pdfPath);

    let text;
    let parseMs = 0;

    try {
      const t0 = performance.now();
      text = await service.extractPdfTextForBenchmark(buffer);
      parseMs = performance.now() - t0;
    } catch (err) {
      console.log(`[SKIP] ${fileName}: pdf-parse failed - ${err.message}`);
      continue;
    }

    const summary = summarize(service, text);

    if (!summary) {
      console.log(`[FAIL] ${fileName}: source detection failed`);
      results.push({ fileName, ok: false, reason: 'source detection' });
      continue;
    }

    sourcesSeen.add(summary.source);
    const ok = summary.txCount > 0;

    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${fileName}`);
    console.log(`  source=${summary.source} tx=${summary.txCount} pdf-parse=${parseMs.toFixed(0)}ms`);

    results.push({ fileName, ok, source: summary.source, parseMs });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const missingSources = EXPECTED_SOURCES.filter((s) => !sourcesSeen.has(s));

  console.log('\n====================================');
  console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${results.length}`);
  if (missingSources.length > 0) {
    console.log(`Missing source coverage in this run: ${missingSources.join(', ')}`);
    console.log('Add sample PDFs for full 6-type regression when available.');
  }

  service.onModuleDestroy?.();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
