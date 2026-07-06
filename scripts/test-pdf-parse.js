const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { execSync } = require('child_process');

// Resolve StatementService from dist folder (handles running from host and inside docker container, with and without src/ folder)
let StatementService;
const possiblePaths = [
  '../dist/src/statement/statement.service.js',
  './dist/src/statement/statement.service.js',
  '../dist/statement/statement.service.js',
  './dist/statement/statement.service.js',
];

let loadedPath = '';
for (const p of possiblePaths) {
  try {
    StatementService = require(p).StatementService;
    loadedPath = p;
    break;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND' || !err.message.includes(p)) {
      console.error(`Error loading from ${p}:`, err.stack || err);
    }
  }
}

if (!StatementService) {
  console.error("Error: Failed to load StatementService. Ensure the project is compiled ('npm run build') and the 'dist' folder exists.");
  console.error('Tried paths:');
  possiblePaths.forEach((p) => console.error(` - ${p}`));
  process.exit(1);
}

const mockPrisma = {};

function printUsage() {
  console.log(`
PDF Statement Parsing Performance Benchmark Utility (Docker & Node JS)
===================================================
Usage:
  node test-pdf-parse.js <path-to-pdf> [options]

Options:
  --password, -p <password>   Password for the PDF if it is encrypted
  --engine <engine>           Extraction engine: auto (default), poppler, pdf-parse, both
  --help, -h                  Show this help message

Examples:
  node test-pdf-parse.js uploads/alipay_bill.pdf
  node test-pdf-parse.js uploads/wechat_bill.pdf --password 123456
  node test-pdf-parse.js uploads/wechat_bill.pdf --engine both
  node test-pdf-parse.js uploads/wechat_bill.pdf --engine poppler
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    filePath: '',
    password: undefined,
    engine: 'auto',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      printUsage();
      process.exit(0);
    } else if ((args[i] === '--password' || args[i] === '-p') && args[i + 1]) {
      options.password = args[i + 1];
      i++;
    } else if (args[i] === '--engine' && args[i + 1]) {
      const engine = args[i + 1];
      if (!['auto', 'poppler', 'pdf-parse', 'both'].includes(engine)) {
        console.error(`Error: Invalid engine "${engine}". Use auto, poppler, pdf-parse, or both.`);
        process.exit(1);
      }
      options.engine = engine;
      i++;
    } else if (!args[i].startsWith('-')) {
      options.filePath = args[i];
    }
  }

  return options;
}

function detectPdftotext() {
  try {
    execSync('pdftotext -v', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function extractText(service, buffer, password, engine) {
  const start = performance.now();
  const text = await service.extractPdfTextForBenchmark(buffer, password, engine);
  const durationMs = performance.now() - start;
  return { text, durationMs };
}

function summarizeParsed(service, text) {
  const source = service.detectSourceFromText(text);
  if (!source) {
    return { source: null, parsedData: null };
  }
  return { source, parsedData: service.extractData(text, source) };
}

function printParsedSummary(label, summary) {
  if (!summary.parsedData) {
    console.log(`  [${label}] Source detection failed`);
    return;
  }
  const { summary: s, transactions } = summary.parsedData;
  console.log(`  [${label}] Source: ${summary.source}`);
  console.log(`  [${label}] Transactions: ${transactions.length}`);
  console.log(`  [${label}] Income/Expense: ${s.totalIncome.toFixed(2)} / ${s.totalExpenditure.toFixed(2)}`);
  console.log(`  [${label}] Date Range: ${s.startDate} to ${s.endDate}`);
}

function compareParsed(baseline, candidate) {
  if (!baseline.parsedData || !candidate.parsedData) {
    return { ok: false, reason: 'source detection mismatch' };
  }
  const b = baseline.parsedData;
  const c = candidate.parsedData;
  const diffs = [];
  if (baseline.source !== candidate.source) {
    diffs.push(`source: ${baseline.source} vs ${candidate.source}`);
  }
  if (b.transactions.length !== c.transactions.length) {
    diffs.push(`txCount: ${b.transactions.length} vs ${c.transactions.length}`);
  }
  if (b.summary.totalIncome !== c.summary.totalIncome) {
    diffs.push(`income: ${b.summary.totalIncome} vs ${c.summary.totalIncome}`);
  }
  if (b.summary.totalExpenditure !== c.summary.totalExpenditure) {
    diffs.push(`expense: ${b.summary.totalExpenditure} vs ${c.summary.totalExpenditure}`);
  }
  return { ok: diffs.length === 0, diffs };
}

async function runSingleEngineBenchmark(service, fileBuffer, password, engine) {
  service.onModuleInit?.();

  if (engine === 'auto') {
    console.log('\n[Step 2/4] Extracting text (auto: poppler with pdf-parse fallback)...');
    const cold = await extractText(service, fileBuffer, password, 'auto');
    console.log(`  -> Cold run: ${cold.durationMs.toFixed(2)}ms, ${cold.text.length} chars`);

    const warmStart = performance.now();
    await service.extractPdfTextForBenchmark(fileBuffer, password, 'auto');
    const warmMs = performance.now() - warmStart;
    console.log(`  -> Warm run: ${warmMs.toFixed(2)}ms`);

    return { text: cold.text, parsePdfTime: warmMs, engineUsed: 'auto' };
  }

  console.log(`\n[Step 2/4] Extracting text via ${engine}...`);
  const cold = await extractText(service, fileBuffer, password, engine);
  console.log(`  -> Cold run: ${cold.durationMs.toFixed(2)}ms, ${cold.text.length} chars`);

  const warmStart = performance.now();
  await service.extractPdfTextForBenchmark(fileBuffer, password, engine);
  const warmMs = performance.now() - warmStart;
  console.log(`  -> Warm run: ${warmMs.toFixed(2)}ms`);

  return { text: cold.text, parsePdfTime: warmMs, engineUsed: engine };
}

async function runBothEnginesBenchmark(service, fileBuffer, password) {
  service.onModuleInit?.();

  console.log('\n[Step 2/4] Comparing poppler vs pdf-parse...');

  const poppler = await extractText(service, fileBuffer, password, 'poppler');
  console.log(`  -> Poppler: ${poppler.durationMs.toFixed(2)}ms, ${poppler.text.length} chars`);

  const pdfParseCold = await extractText(service, fileBuffer, password, 'pdf-parse');
  console.log(`  -> pdf-parse (cold): ${pdfParseCold.durationMs.toFixed(2)}ms, ${pdfParseCold.text.length} chars`);

  const warmStart = performance.now();
  const pdfParseWarmText = await service.extractPdfTextForBenchmark(fileBuffer, password, 'pdf-parse');
  const pdfParseWarmMs = performance.now() - warmStart;
  console.log(`  -> pdf-parse (warm): ${pdfParseWarmMs.toFixed(2)}ms`);

  const popplerSummary = summarizeParsed(service, poppler.text);
  const pdfParseSummary = summarizeParsed(service, pdfParseWarmText);
  printParsedSummary('poppler', popplerSummary);
  printParsedSummary('pdf-parse', pdfParseSummary);

  const comparison = compareParsed(pdfParseSummary, popplerSummary);
  const speedup = pdfParseWarmMs > 0 ? (pdfParseWarmMs / poppler.durationMs).toFixed(2) : 'N/A';

  console.log('\n==================================================');
  console.log('             ENGINE COMPARISON SUMMARY            ');
  console.log('==================================================');
  console.log(`Poppler time:        ${poppler.durationMs.toFixed(2)}ms`);
  console.log(`pdf-parse warm time: ${pdfParseWarmMs.toFixed(2)}ms`);
  console.log(`Speedup (pdf-parse/poppler): ${speedup}x`);
  if (comparison.ok) {
    console.log('Parse result diff:   MATCH (tx count, income, expense)');
  } else {
    console.log(`Parse result diff:   MISMATCH (${comparison.diffs.join(', ')})`);
  }
  console.log('Recommended engine:  poppler (if installed and results match)');
  console.log('==================================================');

  return {
    text: popplerSummary.parsedData ? poppler.text : pdfParseWarmText,
    parsePdfTime: poppler.durationMs,
    engineUsed: 'both',
  };
}

async function main() {
  const options = parseArgs();

  if (!options.filePath) {
    console.error('Error: Missing PDF file path.');
    printUsage();
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), options.filePath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`Error: File not found at path "${absolutePath}"`);
    process.exit(1);
  }

  console.log('==================================================');
  console.log('      PDF PARSING PERFORMANCE TEST RUNNER (JS)    ');
  console.log('==================================================');
  console.log(`File Path:  ${absolutePath}`);
  console.log(`Loaded From:${loadedPath}`);
  console.log(`Engine:     ${options.engine}`);
  console.log(`pdftotext:  ${detectPdftotext() ? 'available' : 'not found (poppler will fallback in auto mode)'}`);
  console.log(`Password:   ${options.password ? '******** (Provided)' : 'None'}`);
  console.log(`Node Ver:   ${process.version}`);
  console.log('--------------------------------------------------');

  const service = new StatementService(mockPrisma);

  console.log('\n[Step 1/4] Reading PDF file into memory buffer...');
  const readStart = performance.now();
  const fileBuffer = fs.readFileSync(absolutePath);
  const readTime = performance.now() - readStart;
  console.log(`  -> Completed: Loaded ${fileBuffer.length} bytes in ${readTime.toFixed(2)}ms`);

  let text = '';
  let parsePdfTime = 0;

  try {
    if (options.engine === 'both') {
      const result = await runBothEnginesBenchmark(service, fileBuffer, options.password);
      text = result.text;
      parsePdfTime = result.parsePdfTime;
    } else {
      const result = await runSingleEngineBenchmark(service, fileBuffer, options.password, options.engine);
      text = result.text;
      parsePdfTime = result.parsePdfTime;
    }
  } catch (err) {
    if (err.name === 'PasswordException') {
      console.error('\n[ERROR] PDF is encrypted/password protected.');
      console.error('Please specify the password using the --password option.');
    } else {
      console.error('\n[ERROR] PDF structure parsing failed:', err);
    }
    process.exit(1);
  }

  if (options.engine !== 'both') {
    console.log('\n[DEBUG] Extracted Text Structure Info:');
    console.log('--- Sample Text (First 1000 Chars) ---');
    console.log(text.slice(0, 1000));
    console.log('--------------------------------------');
  }

  console.log('\n[Step 3/4] Running source identification (bank/channel recognition)...');
  const detectStart = performance.now();
  const source = service.detectSourceFromText(text);
  const detectTime = performance.now() - detectStart;

  if (!source) {
    console.error('  -> Failed: Unrecognized statement source!');
    console.log(`\nExtracted Text Sample (First 500 chars):\n${text.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`  -> Completed: Detected Source: "${source}" in ${detectTime.toFixed(2)}ms`);

  console.log('\n[Step 4/4] Running data extraction & regex parsing...');
  const extractStart = performance.now();
  const parsedData = service.extractData(text, source);
  const extractTime = performance.now() - extractStart;
  console.log(`  -> Completed: Parsed transactions and summary in ${extractTime.toFixed(2)}ms`);

  const totalTime = readTime + parsePdfTime + detectTime + extractTime;
  console.log('\n==================================================');
  console.log('             PERFORMANCE REPORT SUMMARY           ');
  console.log('==================================================');
  console.log(`1. File Loading:       ${readTime.toFixed(2)}ms (${((readTime / totalTime) * 100).toFixed(1)}%)`);
  console.log(`2. Text Extraction:    ${parsePdfTime.toFixed(2)}ms (${((parsePdfTime / totalTime) * 100).toFixed(1)}%)`);
  console.log(`3. Source Detection:   ${detectTime.toFixed(2)}ms (${((detectTime / totalTime) * 100).toFixed(1)}%)`);
  console.log(`4. Regex & Extraction: ${extractTime.toFixed(2)}ms (${((extractTime / totalTime) * 100).toFixed(1)}%)`);
  console.log('--------------------------------------------------');
  console.log(`Total Parsing Time:    ${totalTime.toFixed(2)}ms (${(totalTime / 1000).toFixed(3)}s)`);
  console.log('==================================================');

  console.log('\n==================================================');
  console.log('               PARSED DATA VALIDATION             ');
  console.log('==================================================');
  console.log(`Name:             ${parsedData.summary.name}`);
  console.log(`ID Number (raw):  ${parsedData.summary.idNumber}`);
  console.log(`Card Number:      ${parsedData.summary.cardNumber || 'N/A'}`);
  console.log(`Date Range:       ${parsedData.summary.startDate} to ${parsedData.summary.endDate}`);
  console.log(`Transactions Count: ${parsedData.transactions.length}`);
  console.log(`Total Income:      ${parsedData.summary.totalIncome.toFixed(2)}`);
  console.log(`Total Expenditure: ${parsedData.summary.totalExpenditure.toFixed(2)}`);
  console.log(`Self Income:       ${parsedData.summary.selfIncome.toFixed(2)}`);
  console.log(`Self Expenditure:  ${parsedData.summary.selfExpenditure.toFixed(2)}`);
  console.log('==================================================\n');

  service.onModuleDestroy?.();
}

main().catch((err) => {
  console.error('Fatal error during benchmark execution:', err);
  process.exit(1);
});
