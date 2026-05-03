import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { QuantErrorFilter } from './common/quant-error.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new QuantErrorFilter());
  // v1 is loopback-only; the web dev server runs on a separate port
  // (Next: 3000 / 3100, Nest: 3001), so the browser issues cross-origin
  // requests that need CORS. Restrict to localhost variants.
  app.enableCors({
    origin: [/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/],
    credentials: true,
    allowedHeaders: ['content-type', 'x-trace-id'],
    exposedHeaders: ['x-trace-id'],
  });
  const host = process.env['API_HOST'] ?? '127.0.0.1';
  const portRaw = process.env['API_PORT'] ?? '3001';
  const port = Number.parseInt(portRaw, 10);
  if (Number.isNaN(port)) {
    throw new Error(`Invalid API_PORT: ${portRaw}`);
  }
  await app.listen(port, host);
  Logger.log(`API listening on http://${host}:${String(port)}`, 'Bootstrap');
}

void bootstrap();
