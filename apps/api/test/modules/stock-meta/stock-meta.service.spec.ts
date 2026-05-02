import { QuantError, type StockMetaDto } from '@quant/shared';
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
}

describe('StockMetaService', () => {
  let port: FakePort;
  let service: StockMetaService;

  beforeEach(() => {
    port = new FakePort({ '600519': SAMPLE });
    service = new StockMetaService(port);
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
    service = new StockMetaService(port);
    const all = await service.listAll('tid');
    expect(all.map((m) => m.code)).toEqual(['000858', '600519']);
    expect(port.traceIds).toEqual(['tid']);
  });
});
