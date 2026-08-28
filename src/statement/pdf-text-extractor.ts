import { Logger } from '@nestjs/common';
import { PasswordException } from 'pdf-parse';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';

export type PdfExtractProgress = (
  progress: number,
  stage: string,
  detail: string,
) => void;

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

  isCorruptedText(text: string): boolean {
    if (!text || text.length < 50) return false;
    const controlMatches = text.match(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g);
    const controlCount = controlMatches ? controlMatches.length : 0;
    if (controlCount > 50 && controlCount / text.length > 0.05) {
      return true;
    }
    if (controlCount > 200) {
      return true;
    }
    const puaMatches = text.match(/[\uE000-\uF8FF]/g);
    const puaCount = puaMatches ? puaMatches.length : 0;
    if (puaCount > 50 && puaCount / text.length > 0.1) {
      return true;
    }
    return false;
  }

  async extractWithFontDecoder(
    buffer: Buffer,
    password?: string,
    onProgress?: PdfExtractProgress,
  ): Promise<string> {
    onProgress?.(30, 'font_decoder', '正在通过字体逆向引擎解码文字...');
    const tempFile = path.join(
      os.tmpdir(),
      `pdf_decode_${Date.now()}_${Math.random().toString(36).substring(2)}.pdf`,
    );
    await fs.promises.writeFile(tempFile, buffer);

    const scriptPath = path.resolve(
      process.cwd(),
      'scripts/decode-pdf-glyphs.py',
    );
    return new Promise<string>((resolve, reject) => {
      const args = [scriptPath, tempFile];
      if (password) {
        args.push(password);
      }

      execFile(
        'python3',
        args,
        { maxBuffer: 50 * 1024 * 1024 },
        async (err, stdout, stderr) => {
          await fs.promises.unlink(tempFile).catch(() => {});
          if (err) {
            reject(
              new Error(
                `decode-pdf-glyphs.py failed: ${err.message || stderr || err}`,
              ),
            );
          } else {
            onProgress?.(85, 'font_decoder', '字体逆向解码完成');
            resolve(stdout);
          }
        },
      );
    });
  }

  async extract(
    buffer: Buffer,
    password?: string,
    onProgress?: PdfExtractProgress,
  ): Promise<string> {
    const text = await this.extractWithPdfParse(buffer, password, onProgress);
    if (this.isCorruptedText(text)) {
      this.logger.warn(
        'PDF text appears corrupted or missing ToUnicode CMap. Attempting font glyph reverse decoding fallback...',
      );
      try {
        const decodedText = await this.extractWithFontDecoder(
          buffer,
          password,
          onProgress,
        );
        if (decodedText && decodedText.trim().length > 0) {
          this.logger.log(
            `Successfully recovered PDF text via font glyph decoder (${decodedText.length} chars)`,
          );
          return decodedText;
        }
      } catch (err) {
        this.logger.warn(
          `Font glyph reverse decoding fallback failed: ${err?.message || err}`,
        );
      }
    }
    return text;
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
      path
        .resolve(process.cwd(), 'node_modules/pdfjs-dist/cmaps')
        .replace(/\\/g, '/') + '/';
    const localStandardFontDataUrl =
      path
        .resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts')
        .replace(/\\/g, '/') + '/';

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

            const fullText = (result.text.endsWith('\\n\\n') ? result.text : result.text + '\\n\\n').replace(/\u0000/g, '');
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
        this.logger.error(
          `PDF parse worker exited with code ${code}, recreating...`,
        );
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
      task.reject(
        new Error('PDF parse worker crashed or exited during execution'),
      );
    }

    this.initializeWorker();
  }
}
