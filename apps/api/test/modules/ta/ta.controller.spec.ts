import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TaAnalysis as ViewTaAnalysis, TaSectorAnalysis } from '@quant/shared';

import type { AuthenticatedUser } from '../../../src/modules/auth/request-with-user.js';
import { TaController } from '../../../src/modules/ta/ta.controller.js';
import type { TaService } from '../../../src/modules/ta/ta.service.js';
import type { RequestWithTraceId } from '../../../src/common/trace.middleware.js';

const SAMPLE: ViewTaAnalysis = {
  code: '600519',
  asof: '2026-05-06',
  barsCount: 90,
  supportLevels: [{ price: '1500.00', strength: 'strong', reason: 'MA60 + 前低密集成交区' }],
  resistanceLevels: [{ price: '1800.00', strength: 'medium', reason: '上方筹码峰' }],
  trend: { direction: 'up', horizonDays: 10, confidence: 0.7, rationale: 'MA 多头排列' },
  patterns: ['上升三角形整理'],
  caveats: [],
  provider: 'moonshot',
  cachedAt: '2026-05-06T08:00:00.000+00:00',
};

const SAMPLE_SECTOR: TaSectorAnalysis = {
  codes: ['600519', '000858'],
  trendBreakdown: { up: 2, down: 0, sideways: 0 },
  overallDirection: 'up',
  overallConfidence: 0.7,
  members: [
    {
      code: '600519',
      name: '',
      asof: '2026-05-06',
      trend: SAMPLE.trend,
      keyResistance: '1800.00',
      keySupport: '1500.00',
      headline: 'MA 多头排列',
    },
    {
      code: '000858',
      name: '',
      asof: '2026-05-06',
      trend: SAMPLE.trend,
      keyResistance: null,
      keySupport: null,
      headline: 'MA 多头排列',
    },
  ],
  summary: '白酒板块上行',
  caveats: [],
  cachedAt: '2026-05-06T08:00:00.000+00:00',
};

interface FakeTa {
  readonly ta: TaService;
  readonly analyzeOne: jest.Mock;
  readonly getCached: jest.Mock;
  readonly analyzeSector: jest.Mock;
}

function fakeTa(
  overrides: {
    analyzeOne?: jest.Mock;
    getCached?: jest.Mock;
    analyzeSector?: jest.Mock;
  } = {},
): FakeTa {
  const analyzeOne = overrides.analyzeOne ?? jest.fn().mockResolvedValue(SAMPLE);
  const getCached = overrides.getCached ?? jest.fn().mockResolvedValue(SAMPLE);
  const analyzeSector = overrides.analyzeSector ?? jest.fn().mockResolvedValue(SAMPLE_SECTOR);
  const ta = { analyzeOne, getCached, analyzeSector } as unknown as TaService;
  return { ta, analyzeOne, getCached, analyzeSector };
}

function makeCtrl(ta: TaService): TaController {
  return new TaController(ta);
}

const traceReq = { traceId: 'trace-test' } as RequestWithTraceId;

const adminUser: AuthenticatedUser = {
  id: 'admin',
  displayName: 'Admin',
  source: 'env',
  imBootstrap: false,
};

describe('TaController', () => {
  describe('GET /api/ta/analyze_one', () => {
    it('returns the cached payload from TaService', async () => {
      const { ta, getCached } = fakeTa();
      const ctrl = makeCtrl(ta);
      const result = await ctrl.getOneCached(traceReq, { code: '600519' });
      expect(getCached).toHaveBeenCalledWith('600519', 'trace-test');
      expect(result.code).toBe('600519');
      expect(result.trend.direction).toBe('up');
      expect(result.cachedAt).toMatch(/\+00:00$|Z$/u);
    });

    it('throws NotFoundException on cache miss', async () => {
      const { ta } = fakeTa({ getCached: jest.fn().mockResolvedValue(null) });
      const ctrl = makeCtrl(ta);
      await expect(ctrl.getOneCached(traceReq, { code: '600519' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /api/ta/analyze_one', () => {
    it('forwards bypassCache=true to TaService.analyzeOne', async () => {
      const { ta, analyzeOne } = fakeTa();
      const ctrl = makeCtrl(ta);
      const result: ViewTaAnalysis = await ctrl.analyzeOne(traceReq, adminUser, {
        code: '600519',
        bypassCache: true,
      });
      expect(analyzeOne).toHaveBeenCalledWith('600519', true, {
        userId: 'admin',
        traceId: 'trace-test',
      });
      expect(result.code).toBe('600519');
    });

    it('passes bypassCache=false when omitted', async () => {
      const { ta, analyzeOne } = fakeTa();
      const ctrl = makeCtrl(ta);
      await ctrl.analyzeOne(traceReq, adminUser, { code: '600519' });
      expect(analyzeOne).toHaveBeenCalledWith('600519', false, {
        userId: 'admin',
        traceId: 'trace-test',
      });
    });
  });

  describe('POST /api/ta/analyze_many', () => {
    it('delegates the full sector aggregation to TaService.analyzeSector', async () => {
      const { ta, analyzeSector } = fakeTa();
      const ctrl = makeCtrl(ta);
      const out = await ctrl.analyzeMany(traceReq, adminUser, {
        codes: ['600519', '000858'],
        label: '白酒',
      });
      expect(analyzeSector).toHaveBeenCalledTimes(1);
      expect(analyzeSector.mock.calls[0]?.[0]).toEqual({
        codes: ['600519', '000858'],
        label: '白酒',
        ctx: { userId: 'admin', traceId: 'trace-test' },
      });
      expect(out.codes).toEqual(['600519', '000858']);
      expect(out.overallDirection).toBe('up');
      expect(out.summary).toBe('白酒板块上行');
      expect(out.members.length).toBe(2);
    });

    it('rewraps "no member TA could be produced" into BadRequestException', async () => {
      const analyzeSector = jest
        .fn()
        .mockRejectedValue(new Error('no member TA could be produced'));
      const { ta } = fakeTa({ analyzeSector });
      const ctrl = makeCtrl(ta);
      await expect(ctrl.analyzeMany(traceReq, adminUser, { codes: ['600519'] })).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
