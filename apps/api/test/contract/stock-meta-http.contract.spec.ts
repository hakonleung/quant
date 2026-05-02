/**
 * Cross-process HTTP contract test for the stock-meta feature (F1).
 *
 * Spins:
 *   1. Python Flight server (`python -m quant_rpc`) on an ephemeral port.
 *   2. NestJS app, pointed at that port via `QUANT_FLIGHT_TARGET`.
 *
 * Then drives real HTTP requests through `supertest` and asserts the
 * shape returned matches `StockMetaDtoSchema`. This proves the whole
 * stack — controller → service → Flight adapter → Arrow → DTO mapper —
 * agrees with the Python server.
 */

import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StockMetaDtoSchema, TRACE_HEADER } from '@quant/shared';
import { AppModule } from '../../src/app.module.js';
import { QuantErrorFilter } from '../../src/common/quant-error.filter.js';
import { startPythonFlightServer, type PythonFlightServer } from '../_util/flight-server.js';

jest.setTimeout(30_000);

describe('GET /api/stocks/* (HTTP contract)', () => {
  let pyServer: PythonFlightServer;
  let app: INestApplication;

  beforeAll(async () => {
    pyServer = await startPythonFlightServer();
    process.env['QUANT_FLIGHT_TARGET'] = pyServer.target;
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new QuantErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pyServer.shutdown();
  });

  it('GET /api/stocks/:code returns a valid StockMetaDto', async () => {
    const res = await request(app.getHttpServer()).get('/api/stocks/600519.SH').expect(200);
    expect(() => StockMetaDtoSchema.parse(res.body)).not.toThrow();
    expect(res.body).toMatchObject({ code: '600519.SH', exchange: 'SH' });
    expect(res.headers[TRACE_HEADER]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('GET /api/stocks/:code → 404 with STOCK_NOT_FOUND envelope when missing', async () => {
    const res = await request(app.getHttpServer()).get('/api/stocks/999999.SH').expect(404);
    expect(res.body).toMatchObject({ code: 'STOCK_NOT_FOUND' });
    expect(res.body.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('GET /api/stocks/batch?codes=a,b returns rows in input order', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/stocks/batch?codes=600519.SH,000858.SZ')
      .expect(200);
    expect(res.body.map((r: { code: string }) => r.code)).toEqual(['600519.SH', '000858.SZ']);
    for (const row of res.body) {
      expect(() => StockMetaDtoSchema.parse(row)).not.toThrow();
    }
  });

  it('GET /api/stocks/batch silently skips unknown codes', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/stocks/batch?codes=600519.SH,does-not-exist,000858.SZ')
      .expect(200);
    expect(res.body.map((r: { code: string }) => r.code)).toEqual(['600519.SH', '000858.SZ']);
  });

  it('GET /api/stocks/batch → 400 INVALID_ARGUMENT when codes is missing', async () => {
    const res = await request(app.getHttpServer()).get('/api/stocks/batch').expect(400);
    expect(res.body.code).toBe('INVALID_ARGUMENT');
  });

  it('GET /api/stocks/by-industry returns sorted results', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/stocks/by-industry')
      .query({ sw_l2: '白酒' })
      .expect(200);
    expect(res.body.map((r: { code: string }) => r.code)).toEqual(['000858.SZ', '600519.SH']);
  });

  it('GET /api/stocks/by-industry → 200 [] for an unknown industry', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/stocks/by-industry')
      .query({ sw_l2: 'not-an-industry' })
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('propagates client x-trace-id header end-to-end', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/stocks/600519.SH')
      .set(TRACE_HEADER, 'http-tid-123')
      .expect(200);
    expect(res.headers[TRACE_HEADER]).toBe('http-tid-123');
  });
});
