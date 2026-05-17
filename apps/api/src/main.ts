import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { QuantErrorFilter } from './common/quant-error.filter.js';
import { bootstrapConfigCenter } from './config/config-center-nest-bootstrap.js';
import { corsOriginCallback } from './modules/socket/cors-origin.js';

async function bootstrap(): Promise<void> {
  // Parse env once at bootstrap so misconfiguration fails fast rather
  // than surfacing as a per-request surprise. Every consumer reads
  // through ServerConfigCenter from here on; never `process.env` again.
  const configCenter = bootstrapConfigCenter();
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new QuantErrorFilter());
  // Hook SIGINT/SIGTERM so providers implementing OnApplicationShutdown
  // (e.g. UserLlmLedgerStore drains its in-memory write buffer) run
  // before the process exits. Without this Nest does not register the
  // signal handlers and the shutdown sequence is skipped.
  app.enableShutdownHooks();
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
  const { host, port } = configCenter.server;
  await app.listen(port, host);
  Logger.log(`API listening on http://${host}:${String(port)}`, 'Bootstrap');
}

void bootstrap();
