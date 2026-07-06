const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

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
    // If it's a code/syntax error inside the file itself rather than a file-not-found error, we want to know
    if (err.code !== 'MODULE_NOT_FOUND' || !err.message.includes(p)) {
      console.error(`Error loading from ${p}:`, err.stack || err);
    }
  }
}

if (!StatementService) {
  console.error("Error: Failed to load StatementService. Ensure the project is compiled ('npm run build') and the 'dist' folder exists.");
  console.error("Tried paths:");
  possiblePaths.forEach(p => console.error(` - ${p}`));
  process.exit(1);
}


// Mock PrismaService since we only test local PDF parsing and don't need a DB connection
const mockPrisma = {};

// Helper to print help/usage message
function printUsage() {
  console.log(`
PDF Statement Parsing Performance Benchmark Utility (Docker & Node JS)
===================================================
Usage:
  node test-pdf-parse.js <path-to-pdf> [options]

Options:
  --password, -p <password>   Password for the PDF if it is encrypted
  --help, -h                  Show this help message

Example:
  node test-pdf-parse.js uploads/alipay_bill.pdf
  node test-pdf-parse.js uploads/wechat_bill.pdf --password 123456
`);
}

// Simple argument parser
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    filePath: '',
    password: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      printUsage();
      process.exit(0);
    } else if ((args[i] === '--password' || args[i] === '-p') && args[i + 1]) {
      options.password = args[i + 1];
      i++;
    } else if (!args[i].startsWith('-')) {
      options.filePath = args[i];
    }
  }

  return options;
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
  console.log(`Password:   ${options.password ? '******** (Provided)' : 'None'}`);
  console.log(`Node Ver:   ${process.version}`);
  console.log('--------------------------------------------------');

  const instantiatingStart = performance.now();
  const service = new StatementService(mockPrisma);
  const instantiatingEnd = performance.now();
  const instantiatingTime = instantiatingEnd - instantiatingStart;
  console.log(`[Init] Service Instantiated in ${instantiatingTime.toFixed(2)}ms`);

  // Step 1: Read File to Buffer
  console.log('\n[Step 1/4] Reading PDF file into memory buffer...');
  const readStart = performance.now();
  const fileBuffer = fs.readFileSync(absolutePath);
  const readEnd = performance.now();
  const readTime = readEnd - readStart;
  console.log(`  -> Completed: Loaded ${fileBuffer.length} bytes in ${readTime.toFixed(2)}ms`);

  // Step 2: PDF Parsing (Text Extraction via Worker)
  console.log('\n[Step 2/4] Parsing PDF structure and extracting text (via Worker)...');
  
  // Run 1: Cold Start (spins up worker and compiles libraries)
  console.log('  Running First Parse (Cold Start, Worker Initialization)...');
  const parsePdfStart1 = performance.now();
  let text = '';
  try {
    text = await service.parsePdfText(fileBuffer, options.password);
  } catch (err) {
    if (err.name === 'PasswordException') {
      console.error('\n[ERROR] PDF is encrypted/password protected.');
      console.error('Please specify the password using the --password option.');
    } else {
      console.error('\n[ERROR] PDF structure parsing failed:', err);
    }
    process.exit(1);
  }
  const parsePdfEnd1 = performance.now();
  const parsePdfTime1 = parsePdfEnd1 - parsePdfStart1;
  console.log(`    -> Run 1 (Cold) Completed: Extracted ${text.length} characters in ${parsePdfTime1.toFixed(2)}ms`);

  // Run 2: Warm Start (uses the already running, compiled worker)
  console.log('  Running Second Parse (Warm Start, Reusing Worker)...');
  const parsePdfStart2 = performance.now();
  try {
    await service.parsePdfText(fileBuffer, options.password);
  } catch (err) {
    console.error('\n[ERROR] Warm-up parse failed:', err);
    process.exit(1);
  }
  const parsePdfEnd2 = performance.now();
  const parsePdfTime2 = parsePdfEnd2 - parsePdfStart2;
  console.log(`    -> Run 2 (Warm) Completed: Extracted ${text.length} characters in ${parsePdfTime2.toFixed(2)}ms`);
  
  // Use the warm parse time as the true measure of production performance
  const parsePdfTime = parsePdfTime2;

  // [DEBUG] Print text sample and date line structures
  console.log('\n[DEBUG] Extracted Text Structure Info:');
  console.log('--- Sample Text (First 1000 Chars) ---');
  console.log(text.slice(0, 1000));
  console.log('--------------------------------------');

  const debugLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  console.log(`Total lines split by \\n: ${debugLines.length}`);
  const dateLines = [];
  for (let i = 0; i < debugLines.length; i++) {
    if (debugLines[i].includes('2025-') || debugLines[i].includes('2026-')) {
      dateLines.push({ index: i, content: debugLines[i], next: debugLines[i+1] || '' });
    }
  }
  console.log(`Date pattern matches found: ${dateLines.length}`);
  console.log('--- Sample Date Matches (First 10) ---');
  dateLines.slice(0, 10).forEach(dl => {
    console.log(`Line [${dl.index}]: "${dl.content}" | Next line: "${dl.next}"`);
  });
  console.log('--------------------------------------');

  // Step 3: Source Detection
  console.log('\n[Step 3/4] Running source identification (bank/channel recognition)...');
  const detectStart = performance.now();
  const source = service.detectSourceFromText(text);
  const detectEnd = performance.now();
  const detectTime = detectEnd - detectStart;

  if (!source) {
    console.error(`  -> Failed: Unrecognized statement source!`);
    console.log(`\nExtracted Text Sample (First 500 chars):\n${text.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`  -> Completed: Detected Source: "${source}" in ${detectTime.toFixed(2)}ms`);

  // Step 4: Data Extraction (Regex & Structural Parsing)
  console.log('\n[Step 4/4] Running data extraction & regex parsing...');
  const extractStart = performance.now();
  const parsedData = service.extractData(text, source);
  const extractEnd = performance.now();
  const extractTime = extractEnd - extractStart;
  console.log(`  -> Completed: Parsed transactions and summary in ${extractTime.toFixed(2)}ms`);

  // Performance Report Summary
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

  // Parsed Data Verification Summary
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
}

main().catch((err) => {
  console.error('Fatal error during benchmark execution:', err);
  process.exit(1);
});
