import { Logger } from '@nestjs/common';
import { PasswordException } from 'pdf-parse';
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type PdfExtractEngine = 'auto' | 'poppler' | 'pdf-parse';

export type PdfExtractProgress = (
  progress: number,
  stage: string,
  detail: string,
) => void;

const MIN_TEXT_LENGTH = 100;
const POPPLER_TIMEOUT_MS = 30_000;
const LARGE_FILE_BYTES = 2 * 1024 * 1024;

export class PdfTextExtractor {
  private worker: Worker | null = null;
  private shuttingDown = false;
  private nextTaskId = 1;
  private pendingTasks = new Map<
    number,
    {
      resolve: (text: string) => void;
      reject: (err: unknown) => void;
      onProgress?: PdfExtractProgress;
    }
  >();

  constructor(private readonly logger = new Logger(PdfTextExtractor.name)) {}

  onModuleInit() {
    this.initializeWorker();
  }

  onModuleDestroy() {
    this.shuttingDown = true;
    if (this.worker) {
      this.worker.terminate().catch(() => {});
      this.worker = null;
    }
  }

  async extract(
    buffer: Buffer,
    password?: string,
    onProgress?: PdfExtractProgress,
    engine: PdfExtractEngine = 'auto',
  ): Promise<string> {
    if (engine === 'pdf-parse') {
      return this.extractWithPdfParse(buffer, password, onProgress);
    }

    if (engine === 'poppler') {
      const popplerResult = await this.extractWithPoppler(buffer, password, onProgress);
      if (popplerResult) {
        this.logger.log(
          `PDF text extracted via poppler in ${popplerResult.durationMs.toFixed(0)}ms (${popplerResult.text.length} chars)`,
        );
        return popplerResult.text;
      }
      throw new Error('Poppler extraction failed');
    }

    onProgress?.(5, 'parsing_pdf', '正在读取 PDF 结构...');

    const popplerResult = await this.extractWithPoppler(buffer, password, onProgress);
    if (popplerResult) {
      onProgress?.(85, 'parsing_pdf', 'PDF 文本提取完成');
      this.logger.log(
        `PDF text extracted via poppler in ${popplerResult.durationMs.toFixed(0)}ms (${popplerResult.text.length} chars)`,
      );
      return popplerResult.text;
    }

    this.logger.warn('Poppler extraction unavailable or insufficient, falling back to pdf-parse');
    return this.extractWithPdfParse(buffer, password, onProgress);
  }

  async extractWithPoppler(
    buffer: Buffer,
    password?: string,
    onProgress?: PdfExtractProgress,
  ): Promise<{ text: string; durationMs: number } | null> {
    const start = performance.now();
    let tmpDir: string | null = null;

    try {
      onProgress?.(10, 'parsing_pdf', '正在使用 Poppler 提取文本...');
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-extract-'));
      const pdfPath = path.join(tmpDir, 'input.pdf');
      await fsp.writeFile(pdfPath, buffer);

      const args = ['-layout', '-enc', 'UTF-8'];
      if (password) {
        args.push('-upw', password);
      }
      args.push(pdfPath, '-');

      const { stdout, stderr, exitCode } = await this.runPdftotext(args);
      const durationMs = performance.now() - start;

      if (exitCode !== 0) {
        this.logger.warn(
          `pdftotext exited with code ${exitCode}: ${stderr.trim().slice(0, 200)}`,
        );
        return null;
      }

      const text = stdout;
      if (text.trim().length < MIN_TEXT_LENGTH) {
        this.logger.warn(
          `pdftotext output too short (${text.trim().length} chars), will fallback`,
        );
        return null;
      }

      const normalized = text.endsWith('\n\n') ? text : `${text}\n\n`;
      return { text: normalized, durationMs };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        this.logger.warn('pdftotext not found on PATH, will fallback to pdf-parse');
      } else {
        this.logger.warn('Poppler extraction error, will fallback to pdf-parse', err);
      }
      return null;
    } finally {
      if (tmpDir) {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async extractWithPdfParse(
    buffer: Buffer,
    password?: string,
    onProgress?: PdfExtractProgress,
  ): Promise<string> {
    const start = performance.now();

    if (!this.worker) {
      this.initializeWorker();
    }

    const localCMapUrl =
      path.resolve(process.cwd(), 'node_modules/pdfjs-dist/cmaps').replace(/\\/g, '/') + '/';
    const localStandardFontDataUrl =
      path.resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') +
      '/';

    const taskId = this.nextTaskId++;
    const text = await new Promise<string>((resolve, reject) => {
      this.pendingTasks.set(taskId, { resolve, reject, onProgress });
      this.worker!.postMessage({
        taskId,
        buffer,
        password,
        cMapUrl: localCMapUrl,
        standardFontDataUrl: localStandardFontDataUrl,
        isLarge: buffer.length >= LARGE_FILE_BYTES,
      });
    });

    const durationMs = performance.now() - start;
    this.logger.log(
      `PDF text extracted via pdf-parse in ${durationMs.toFixed(0)}ms (${text.length} chars)`,
    );
    return text;
  }

  private runPdftotext(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('pdftotext', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`pdftotext timed out after ${POPPLER_TIMEOUT_MS}ms`));
      }, POPPLER_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });
    });
  }

  private initializeWorker() {
    const workerCode = `
      const { parentPort } = require('worker_threads');
      const { PDFParse } = require('pdf-parse');
      const os = require('os');

      if (!parentPort) throw new Error('Must run as worker');

      parentPort.on('message', async (message) => {
        const { taskId, buffer, password, cMapUrl, standardFontDataUrl, isLarge } = message;
        try {
          const loadOptions = {
            data: Buffer.from(buffer),
            password,
            cMapUrl,
            cMapPacked: true,
            standardFontDataUrl,
            verbosity: 0,
          };

          if (isLarge) {
            loadOptions.disableAutoFetch = true;
            loadOptions.disableStream = true;
            loadOptions.rangeChunkSize = 65536;
          }

          const parser = new PDFParse(loadOptions);
          try {
            parentPort.postMessage({
              type: 'progress',
              taskId,
              progress: 10,
              stage: 'parsing_pdf',
              detail: '正在解析 PDF 页面...',
            });

            const result = await parser.getText({
              pageJoiner: '\\n\\n',
              disableNormalization: false,
            });

            parentPort.postMessage({
              type: 'progress',
              taskId,
              progress: 85,
              stage: 'parsing_pdf',
              detail: \`已完成 \${result.total} 页解析\`,
            });

            const fullText = result.text.endsWith('\\n\\n') ? result.text : result.text + '\\n\\n';
            parentPort.postMessage({ success: true, taskId, text: fullText });
          } finally {
            await parser.destroy();
          }
        } catch (error) {
          parentPort.postMessage({
            success: false,
            taskId,
            error: {
              name: error.name || 'Error',
              message: error.message || String(error),
              stack: error.stack,
            },
          });
        }
      });
    `;

    this.worker = new Worker(workerCode, { eval: true });

    this.worker.on('message', (res) => {
      const task = this.pendingTasks.get(res.taskId);
      if (!task) return;

      if (res.type === 'progress') {
        task.onProgress?.(res.progress, res.stage, res.detail);
        return;
      }

      this.pendingTasks.delete(res.taskId);
      if (res.success) {
        task.resolve(res.text);
      } else {
        const errObj = res.error;
        if (errObj.name === 'PasswordException') {
          task.reject(new PasswordException(errObj.message));
        } else {
          const err = new Error(errObj.message);
          err.name = errObj.name;
          err.stack = errObj.stack;
          task.reject(err);
        }
      }
    });

    this.worker.on('error', (err) => {
      this.logger.error('PDF parse worker error, recreating...', err);
      this.recreateWorker();
    });

    this.worker.on('exit', (code) => {
      if (this.shuttingDown) return;
      if (code !== 0) {
        this.logger.error(`PDF parse worker exited with code ${code}, recreating...`);
        this.recreateWorker();
      }
    });
  }

  private recreateWorker() {
    if (this.worker) {
      try {
        this.worker.terminate().catch(() => {});
      } catch {
        // ignore
      }
      this.worker = null;
    }

    const failedTasks = Array.from(this.pendingTasks.values());
    this.pendingTasks.clear();
    for (const task of failedTasks) {
      task.reject(new Error('PDF parse worker crashed or exited during execution'));
    }

    this.initializeWorker();
  }
}
