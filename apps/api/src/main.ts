import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { QuantErrorFilter } from './common/quant-error.filter.js';
import { corsOriginCallback } from './modules/socket/cors-origin.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new QuantErrorFilter());
  // v1 binds 127.0.0.1 by default; the dev web server runs on a separate
  // port so the browser issues cross-origin requests that need CORS.
  // Allow loopback hostnames + same-host different-port to support custom
  // hostnames (e.g. accessing via the LAN ip on a phone). Extra origins
  // can be configured via the QUANT_ALLOWED_ORIGINS env (comma list).
  app.enableCors({
    origin: corsOriginCallback,
    credentials: true,
    allowedHeaders: ['content-type', 'x-trace-id', 'authorization', 'cookie'],
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
