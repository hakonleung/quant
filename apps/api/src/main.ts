import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
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
