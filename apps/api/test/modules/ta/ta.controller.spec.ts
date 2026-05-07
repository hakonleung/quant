import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TaAnalysis as ViewTaAnalysis } from '@quant/shared';

import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import { TaController } from '../../../src/modules/ta/ta.controller.js';
import type { RequestWithTraceId } from '../../../src/common/trace.middleware.js';

interface FakeProxy {
  toJSON(): Record<string, unknown>;
}

class FakeTable {
  constructor(private readonly rows: readonly Readonly<Record<string, unknown>>[]) {}
  get numRows(): number {
    return this.rows.length;
  }
  get(i: number): FakeProxy | null {
    const row = this.rows[i];
    if (row === undefined) return null;
    return { toJSON: () => row };
  }
}

function fakeFlight(payload: unknown): {
  client: FlightClient;
  doGet: jest.Mock;
} {
  const rows = payload === null ? [] : [{ payload_json: JSON.stringify(payload) }];
  const table = new FakeTable(rows);
  const doGet = jest.fn().mockResolvedValue({ value: table, traceId: 'trace-test' });
  const client = { doGet } as unknown as FlightClient;
  return { client, doGet };
}

const traceReq = { traceId: 'trace-test' } as RequestWithTraceId;

const PY_PAYLOAD = {
  code: '600519',
  asof: '2026-05-06',
  bars_count: 90,
  support_levels: [{ price: '1500.00', strength: 'strong', reason: 'MA60 + 前低密集成交区' }],
  resistance_levels: [{ price: '1800.00', strength: 'medium', reason: '上方筹码峰' }],
  trend: {
    direction: 'up',
    horizon_days: 10,
    confidence: 0.7,
    rationale: 'MA 多头排列',
  },
  patterns: ['上升三角形整理'],
  caveats: [],
  fetched_at: '2026-05-06T08:00:00.000+00:00',
  schema_version: 1,
  provider: 'moonshot',
};

describe('TaController', () => {
  describe('GET /api/ta/analyze_one', () => {
    it('returns the cached payload mapped to the view shape', async () => {
      const { client, doGet } = fakeFlight(PY_PAYLOAD);
      const ctrl = new TaController(client);
      const result = await ctrl.getOneCached(traceReq, { code: '600519' });
      expect(doGet).toHaveBeenCalledWith(
        'get_cached_ta_one',
        { code: '600519' },
        { traceId: 'trace-test' },
      );
      expect(result.code).toBe('600519');
      expect(result.trend.direction).toBe('up');
      expect(result.supportLevels[0]?.price).toBe('1500.00');
      expect(result.provider).toBe('moonshot');
      expect(result.cachedAt).toMatch(/\+00:00$|Z$/u);
    });

    it('throws NotFoundException on cache miss (empty table)', async () => {
      const { client } = fakeFlight(null);
      const ctrl = new TaController(client);
      await expect(ctrl.getOneCached(traceReq, { code: '600519' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /api/ta/analyze_one', () => {
    it('forwards bypassCache=true to the Flight call', async () => {
      const { client, doGet } = fakeFlight(PY_PAYLOAD);
      const ctrl = new TaController(client);
      const result: ViewTaAnalysis = await ctrl.analyzeOne(traceReq, {
        code: '600519',
        bypassCache: true,
      });
      expect(doGet).toHaveBeenCalledWith(
        'analyze_ta_one',
        { code: '600519', bypass_cache: true },
        { traceId: 'trace-test' },
      );
      expect(result.code).toBe('600519');
    });

    it('throws BadRequestException when the flight returns nothing', async () => {
      const { client } = fakeFlight(null);
      const ctrl = new TaController(client);
      await expect(ctrl.analyzeOne(traceReq, { code: '600519' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
