import { PDFParse } from 'pdf-parse';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

const cMapUrl = path.resolve(process.cwd(), 'node_modules/pdfjs-dist/cmaps').replace(/\\/g, '/') + '/';
const standardFontDataUrl = path.resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') + '/';

const filePath = 'uploads/e63def0e2b977c389e82ac61288735c6_C25dM12TINJne63def0e2b977c389e82ac61288735c6.pdf';
const fileBuffer = fs.readFileSync(path.resolve(process.cwd(), filePath));

async function runSequential() {
  const parser = new PDFParse({
    data: Buffer.from(fileBuffer),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    verbosity: 0
  }) as any;

  try {
    const doc = await parser.load();
    const total = doc.numPages;
    const pages: string[] = [];
    const getTextOptions = {
      pageJoiner: '',
      disableNormalization: true
    };

    const start = performance.now();
    for (let s = 1; s <= total; s++) {
      const page = await doc.getPage(s);
      const pageText = await parser.getPageText(page, getTextOptions, total);
      pages.push(pageText);
      page.cleanup();
    }
    const end = performance.now();
    return { time: end - start, charCount: pages.join('\n').length, pages: total };
  } finally {
    await parser.destroy();
  }
}

async function runFullParallel() {
  const parser = new PDFParse({
    data: Buffer.from(fileBuffer),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    verbosity: 0
  }) as any;

  try {
    const doc = await parser.load();
    const total = doc.numPages;
    const getTextOptions = {
      pageJoiner: '',
      disableNormalization: true
    };

    const start = performance.now();
    const promises: Promise<{ pageNum: number; text: string }>[] = [];
    for (let s = 1; s <= total; s++) {
      promises.push((async () => {
        const page = await doc.getPage(s);
        const pageText = await parser.getPageText(page, getTextOptions, total);
        page.cleanup();
        return { pageNum: s, text: pageText };
      })());
    }

    const results = await Promise.all(promises);
    results.sort((a, b) => a.pageNum - b.pageNum);
    const pages = results.map(r => r.text);
    const end = performance.now();
    return { time: end - start, charCount: pages.join('\n').length, pages: total };
  } finally {
    await parser.destroy();
  }
}

async function runChunkParallel(chunkSize: number) {
  const parser = new PDFParse({
    data: Buffer.from(fileBuffer),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    verbosity: 0
  }) as any;

  try {
    const doc = await parser.load();
    const total = doc.numPages;
    const pages: string[] = new Array(total);
    const getTextOptions = {
      pageJoiner: '',
      disableNormalization: true
    };

    const start = performance.now();
    
    // Process pages in chunks
    for (let i = 1; i <= total; i += chunkSize) {
      const chunkPromises: Promise<void>[] = [];
      const endPage = Math.min(i + chunkSize - 1, total);
      
      for (let s = i; s <= endPage; s++) {
        const pageNum = s;
        chunkPromises.push((async () => {
          const page = await doc.getPage(pageNum);
          const pageText = await parser.getPageText(page, getTextOptions, total);
          page.cleanup();
          pages[pageNum - 1] = pageText;
        })());
      }
      
      await Promise.all(chunkPromises);
    }

    const end = performance.now();
    return { time: end - start, charCount: pages.join('\n').length, pages: total };
  } finally {
    await parser.destroy();
  }
}

async function main() {
  console.log(`Analyzing PDF: ${filePath} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
  
  console.log('\n--- 1. Running Sequential ---');
  const seq = await runSequential();
  console.log(`Time: ${seq.time.toFixed(2)}ms, Chars: ${seq.charCount}, Pages: ${seq.pages}`);
  
  console.log('\n--- 2. Running Full Parallel ---');
  const full = await runFullParallel();
  console.log(`Time: ${full.time.toFixed(2)}ms, Chars: ${full.charCount}, Pages: ${full.pages}`);

  for (const size of [5, 10, 20, 50]) {
    console.log(`\n--- 3. Running Chunk Parallel (Limit: ${size}) ---`);
    const chunk = await runChunkParallel(size);
    console.log(`Time: ${chunk.time.toFixed(2)}ms, Chars: ${chunk.charCount}, Pages: ${chunk.pages}`);
  }
}

main().catch(console.error);
