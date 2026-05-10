import { QuantError, type StockMetaDto, type StockSnapshotDto } from '@quant/shared';
import type { Clock } from '../../../src/common/clock.js';
import { FrozenClock, SystemClock } from '../../../src/common/clock.js';
import { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';
import type { StockMetaPort } from '../../../src/modules/stock-meta/domain/stock-meta-port.js';

const SAMPLE: StockMetaDto = {
  code: '600519',
  name: '贵州茅台',
  name_pinyin: 'GZMT',
  industries: '食品饮料,白酒',
  list_date: '2001-08-27',
  float_pct: '1',
  updated_at: '2026-05-01T00:00:00+00:00',
  total_share: null,
  float_share: null,
  net_assets: null,
  net_assets_period: null,
  quarterlies: [],
  financials_updated_at: null,
};

class FakePort implements StockMetaPort {
  public readonly traceIds: string[] = [];
  constructor(private readonly byCode: Record<string, StockMetaDto>) {}

  async getOne(code: string, traceId: string): Promise<StockMetaDto | null> {
    this.traceIds.push(traceId);
    return Promise.resolve(this.byCode[code] ?? null);
  }

  async getBatch(codes: readonly string[], traceId: string): Promise<readonly StockMetaDto[]> {
    this.traceIds.push(traceId);
    return Promise.resolve(
      codes.map((c) => this.byCode[c]).filter((x): x is StockMetaDto => x !== undefined),
    );
  }

  async listByIndustry(swL2: string, traceId: string): Promise<readonly StockMetaDto[]> {
    this.traceIds.push(traceId);
    return Promise.resolve(
      Object.values(this.byCode)
        .filter((m) => m.industries.includes(swL2))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );
  }

  async listAll(traceId: string): Promise<readonly StockMetaDto[]> {
    this.traceIds.push(traceId);
    return Promise.resolve(Object.values(this.byCode).sort((a, b) => a.code.localeCompare(b.code)));
  }

  async listSnapshots(
    codes: readonly string[],
    traceId: string,
  ): Promise<readonly StockSnapshotDto[]> {
    this.traceIds.push(traceId);
    const baseDerived = {
      mkt_cap: null,
      float_mkt_cap: null,
      pe_ttm: null,
      pe_dynamic: null,
      pb: null,
      peg: null,
      gross_margin_ttm: null,
    };
    const baseReturns = {
      ret_1d: null,
      ret_5d: null,
      ret_10d: null,
      ret_20d: null,
      ret_90d: null,
      ret_250d: null,
    };
    return Promise.resolve(
      codes
        .map((c) => this.byCode[c])
        .filter((m): m is StockMetaDto => m !== undefined)
        .map((meta) => ({
          meta,
          price: null,
          asof: null,
          derived: baseDerived,
          returns: baseReturns,
        })),
    );
  }
}

describe('StockMetaService', () => {
  let port: FakePort;
  let service: StockMetaService;

  beforeEach(() => {
    port = new FakePort({ '600519': SAMPLE });
    service = new StockMetaService(port, new SystemClock());
  });

  it('returns the dto when the code exists', async () => {
    await expect(service.get('600519', 'tid')).resolves.toEqual(SAMPLE);
    expect(port.traceIds).toEqual(['tid']);
  });

  it('throws QuantError(STOCK_NOT_FOUND) when the code is missing', async () => {
    await expect(service.get('999999', 'tid')).rejects.toMatchObject({
      code: 'STOCK_NOT_FOUND',
    });
  });

  it('short-circuits an empty batch without hitting the port', async () => {
    await expect(service.getBatch([], 'tid')).resolves.toEqual([]);
    expect(port.traceIds).toEqual([]);
  });

  it('forwards a non-empty batch to the port', async () => {
    await expect(service.getBatch(['600519'], 'tid')).resolves.toEqual([SAMPLE]);
    expect(port.traceIds).toEqual(['tid']);
  });

  it('rejects an empty industry string with INVALID_ARGUMENT', async () => {
    await expect(service.listByIndustry('', 'tid')).rejects.toBeInstanceOf(QuantError);
    await expect(service.listByIndustry('', 'tid')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('forwards a non-empty industry string to the port', async () => {
    await expect(service.listByIndustry('白酒', 'tid')).resolves.toEqual([SAMPLE]);
  });

  it('listAll forwards trace_id and returns sorted rows', async () => {
    const second: StockMetaDto = { ...SAMPLE, code: '000858' };
    port = new FakePort({ '600519': SAMPLE, '000858': second });
    service = new StockMetaService(port, new SystemClock());
    const all = await service.listAll('tid');
    expect(all.map((m) => m.code)).toEqual(['000858', '600519']);
    expect(port.traceIds).toEqual(['tid']);
  });

  describe('listAll caching', () => {
    /**
     * Mutable test clock: epoch-ms based so the body never names the
     * built-in `Date` (the eslint `no-restricted-globals` rule reserves
     * that for production code; tests stay in epoch arithmetic and only
     * touch `Date` at the trusted helper below).
     */
    // eslint-disable-next-line no-restricted-globals -- test helper, see comment
    const D = (iso: string): Date => new Date(iso);

    class StepClock implements Clock {
      private currentMs: number;
      constructor(startMs: number) {
        this.currentMs = startMs;
      }
      advance(ms: number): void {
        this.currentMs += ms;
      }
      now(): Date {
        return D(new Date(this.currentMs).toISOString()); // eslint-disable-line no-restricted-globals -- mirror epoch
      }
    }

    const T0 = D('2026-05-09T00:00:00Z').getTime();

    it('returns cached value within TTL without re-hitting the port', async () => {
      const clock = new StepClock(T0);
      const cachedService = new StockMetaService(port, clock);
      await cachedService.listAll('first');
      clock.advance(30_000);
      await cachedService.listAll('second');
      expect(port.traceIds).toEqual(['first']);
    });

    it('serves stale snapshot and triggers a single background revalidation past TTL', async () => {
      const clock = new StepClock(T0);
      const cachedService = new StockMetaService(port, clock);
      const fresh = await cachedService.listAll('cold');
      expect(fresh).toEqual([SAMPLE]);
      clock.advance(120_000);
      const stale = await cachedService.listAll('stale-1');
      expect(stale).toEqual([SAMPLE]);
      // Drain the in-flight revalidation before the next assertion so we
      // don't race with the background promise's port write.
      await new Promise<void>((resolve) => setImmediate(resolve));
      // After the revalidation lands, the port has been hit exactly twice.
      expect(port.traceIds).toEqual(['cold', 'stale-1']);
    });

    it('caches a frozen instant from FrozenClock — entries never expire', async () => {
      const frozen = new FrozenClock(D('2026-05-09T00:00:00Z'));
      const cachedService = new StockMetaService(port, frozen);
      await cachedService.listAll('a');
      await cachedService.listAll('b');
      await cachedService.listAll('c');
      expect(port.traceIds).toEqual(['a']);
    });

    it('clearListAllCache forces the next call back to the port', async () => {
      const clock = new StepClock(T0);
      const cachedService = new StockMetaService(port, clock);
      await cachedService.listAll('first');
      cachedService.clearListAllCache();
      await cachedService.listAll('second');
      expect(port.traceIds).toEqual(['first', 'second']);
    });
  });
});
