import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TaAnalysis as ViewTaAnalysis } from '@quant/shared';

import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import { FrozenClock } from '../../../src/common/clock.js';
import type { AuthenticatedUser } from '../../../src/modules/auth/request-with-user.js';
import type { LlmService } from '../../../src/modules/llm/llm.service.js';
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

function fakeLlm(text = 'sector summary'): LlmService {
  return {
    completeJson: jest.fn().mockResolvedValue({
      text,
      usage: { input: 1, output: 1, total: 2 },
      provider: 'mock',
      model: 'mock-1',
    }),
  } as unknown as LlmService;
}

function makeCtrl(client: FlightClient, llm: LlmService = fakeLlm()): TaController {
  return new TaController(client, llm, new FrozenClock(new Date('2026-05-06T08:00:00.000Z')));
}

const traceReq = { traceId: 'trace-test' } as RequestWithTraceId;

const adminUser: AuthenticatedUser = {
  id: 'admin',
  displayName: 'Admin',
  source: 'env',
  imBootstrap: false,
};

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
      const ctrl = makeCtrl(client);
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
      const ctrl = makeCtrl(client);
      await expect(ctrl.getOneCached(traceReq, { code: '600519' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /api/ta/analyze_one', () => {
    it('forwards bypassCache=true to the Flight call', async () => {
      const { client, doGet } = fakeFlight(PY_PAYLOAD);
      const ctrl = makeCtrl(client);
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
      const ctrl = makeCtrl(client);
      await expect(ctrl.analyzeOne(traceReq, { code: '600519' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('POST /api/ta/analyze_many', () => {
    it('aggregates per-stock TA into a sector view + LLM summary', async () => {
      const { client, doGet } = fakeFlight(PY_PAYLOAD);
      const llm = fakeLlm('白酒板块上行');
      const ctrl = makeCtrl(client, llm);
      const out = await ctrl.analyzeMany(traceReq, adminUser, {
        codes: ['600519', '000858'],
        label: '白酒',
      });
      // Two per-stock fan-out calls.
      expect(doGet).toHaveBeenCalledTimes(2);
      expect(out.codes).toEqual(['600519', '000858']);
      expect(out.overallDirection).toBe('up');
      expect(out.summary).toBe('白酒板块上行');
      expect(out.members.length).toBe(2);
    });

    it('throws when every member fan-out fails', async () => {
      const { client } = fakeFlight(null);
      const ctrl = makeCtrl(client);
      await expect(
        ctrl.analyzeMany(traceReq, adminUser, { codes: ['600519'] }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
