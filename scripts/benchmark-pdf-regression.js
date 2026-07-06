/**
 * Dual-engine regression benchmark for bank statement PDFs.
 *
 * Usage:
 *   node scripts/benchmark-pdf-regression.js uploads/*.pdf
 *   node scripts/benchmark-pdf-regression.js --dir uploads
 *
 * Expects 6 bank/channel types (WeChat, Alipay, CMB, BOCOM, ICBC, Rural Commercial Bank).
 * Compares poppler vs pdf-parse on transaction count, income, and expense totals.
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { execSync } = require('child_process');

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

const EXPECTED_SOURCES = ['微信', '支付宝', '招商银行', '交通银行', '工商银行', '农商银行'];

function hasPdftotext() {
  try {
    execSync('pdftotext -v', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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

function compare(baseline, candidate) {
  const diffs = [];
  if (baseline.source !== candidate.source) diffs.push(`source ${baseline.source} vs ${candidate.source}`);
  if (baseline.txCount !== candidate.txCount) diffs.push(`txCount ${baseline.txCount} vs ${candidate.txCount}`);
  if (baseline.income !== candidate.income) diffs.push(`income ${baseline.income} vs ${candidate.income}`);
  if (baseline.expense !== candidate.expense) diffs.push(`expense ${baseline.expense} vs ${candidate.expense}`);
  return diffs;
}

async function main() {
  const pdfPaths = collectPdfPaths(process.argv.slice(2));

  if (pdfPaths.length === 0) {
    console.log('No PDF files provided.');
    console.log('Usage: node scripts/benchmark-pdf-regression.js --dir uploads');
    console.log('       node scripts/benchmark-pdf-regression.js path/to/sample.pdf');
    process.exit(0);
  }

  if (!hasPdftotext()) {
    console.log('pdftotext not found on PATH.');
    console.log('Install poppler-utils before running dual-engine regression:');
    console.log('  Docker/Alpine: apk add poppler-utils');
    console.log('  Ubuntu/Debian: apt install poppler-utils');
    process.exit(0);
  }

  const service = new StatementService({});
  service.onModuleInit?.();

  const results = [];
  const sourcesSeen = new Set();

  console.log('PDF Engine Regression Benchmark');
  console.log('================================');
  console.log(`Files: ${pdfPaths.length}\n`);

  for (const pdfPath of pdfPaths) {
    const buffer = fs.readFileSync(pdfPath);
    const fileName = path.basename(pdfPath);

    let popplerText;
    let pdfParseText;
    let popplerMs = 0;
    let pdfParseMs = 0;

    try {
      const t0 = performance.now();
      popplerText = await service.extractPdfTextForBenchmark(buffer, undefined, 'poppler');
      popplerMs = performance.now() - t0;
    } catch (err) {
      console.log(`[SKIP] ${fileName}: poppler failed - ${err.message}`);
      continue;
    }

    try {
      const t0 = performance.now();
      pdfParseText = await service.extractPdfTextForBenchmark(buffer, undefined, 'pdf-parse');
      pdfParseMs = performance.now() - t0;
    } catch (err) {
      console.log(`[SKIP] ${fileName}: pdf-parse failed - ${err.message}`);
      continue;
    }

    const popplerSummary = summarize(service, popplerText);
    const pdfParseSummary = summarize(service, pdfParseText);

    if (!popplerSummary || !pdfParseSummary) {
      console.log(`[FAIL] ${fileName}: source detection failed`);
      results.push({ fileName, ok: false, reason: 'source detection' });
      continue;
    }

    sourcesSeen.add(popplerSummary.source);
    const diffs = compare(pdfParseSummary, popplerSummary);
    const ok = diffs.length === 0;
    const speedup = pdfParseMs > 0 ? (pdfParseMs / popplerMs).toFixed(2) : 'N/A';

    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${fileName}`);
    console.log(`  source=${popplerSummary.source} tx=${popplerSummary.txCount} poppler=${popplerMs.toFixed(0)}ms pdf-parse=${pdfParseMs.toFixed(0)}ms speedup=${speedup}x`);
    if (!ok) console.log(`  diffs: ${diffs.join(', ')}`);

    results.push({ fileName, ok, source: popplerSummary.source, diffs, popplerMs, pdfParseMs });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const missingSources = EXPECTED_SOURCES.filter((s) => !sourcesSeen.has(s));

  console.log('\n================================');
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
