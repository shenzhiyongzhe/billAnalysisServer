import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  getLatencyProbe() {
    return {
      ok: true,
      now: new Date().toISOString(),
      uptimeMs: Math.round(process.uptime() * 1000),
      pid: process.pid,
    };
  }
}
