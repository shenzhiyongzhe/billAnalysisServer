import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const apiPrefix = process.env.API_PREFIX || 'api/bill-analysis';
  app.setGlobalPrefix(apiPrefix, {
    exclude: [{ path: '', method: RequestMethod.GET }],
  });
  // Trust first proxy hop so req.ip / X-Forwarded-For work behind Nginx
  const httpAdapter = app.getHttpAdapter().getInstance();
  if (httpAdapter && typeof httpAdapter.set === 'function') {
    httpAdapter.set('trust proxy', 1);
  }
  app.enableCors();
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
}
bootstrap();
