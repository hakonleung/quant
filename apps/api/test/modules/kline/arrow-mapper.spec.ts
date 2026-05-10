/**
 * Regression tests for arrowTableToKlineBars / arrowTableToKlineBarsByCode.
 *
 * The critical regression guarded here: Arrow decimal128 columns arrive as
 * Uint32Array[4] (four little-endian 32-bit limbs of the unscaled integer).
 * The mapper must divide by 10^scale to produce the correct JS number.
 * Before the fix, the raw unscaled integer was returned directly, resulting
 * in prices inflated by 10^scale (×10 000 for scale=4).
 *
 * We build the Arrow table programmatically using apache-arrow builders so
 * any future SDK version bumps that change the on-wire encoding will also
 * fail this test, surfacing the regression immediately.
 */

import {
  Table,
  RecordBatch,
  Schema,
  Field,
  Utf8,
  DateDay,
  Decimal,
  Int64,
  Struct,
  makeData,
  DecimalBuilder,
  Int64Builder,
  Utf8Builder,
  DateDayBuilder,
  type Data,
} from 'apache-arrow';

import {
  arrowTableToKlineBars,
  arrowTableToKlineBarsByCode,
} from '../../../src/modules/kline/domain/arrow-mapper.js';

// ---------------------------------------------------------------------------
// Helpers — build Arrow Data buffers from JS values
// ---------------------------------------------------------------------------

// NOTE: In apache-arrow JS (v21+), Decimal(a, b) assigns a→scale, b→precision.
// This is the reverse of the pyarrow convention (precision, scale). We pass
// (scale, precision) here so that `field.type.scale` reads the correct value
// and arrowTableToKlineBars divides by the right power of 10.
// The apache-arrow JS types don't expose a clean "first chunk" accessor;
// `builder.finish().toVector().data[0]` is the runtime path but the typed
// surface differs across SDK versions. We type the helpers as `Data` and
// rely on `as unknown as Data` at the boundary — fine because the result
// is fed straight into `makeData({ children: [...] })` which accepts any.
function decimalData(unscaledVal: number, scale: number, precision = 20): Data {
  const builder = new DecimalBuilder({ type: new Decimal(scale, precision) });
  const limbs = new Uint32Array(4);
  limbs[0] = unscaledVal;
  builder.append(limbs);
  const v = builder.finish().toVector() as unknown as { data: Data[] };
  return v.data[0]!;
}

function int64Data(val: number): Data {
  const builder = new Int64Builder({ type: new Int64() });
  builder.append(BigInt(val));
  const v = builder.finish().toVector() as unknown as { data: Data[] };
  return v.data[0]!;
}

function utf8Data(val: string): Data {
  const builder = new Utf8Builder({ type: new Utf8() });
  builder.append(val);
  const v = builder.finish().toVector() as unknown as { data: Data[] };
  return v.data[0]!;
}

function dateDayData(d: Date): Data {
  const builder = new DateDayBuilder({ type: new DateDay() });
  builder.append(d);
  const v = builder.finish().toVector() as unknown as { data: Data[] };
  return v.data[0]!;
}

// ---------------------------------------------------------------------------
// Build a one-row Arrow table matching the kline schema
// ---------------------------------------------------------------------------

// Decimal(scale, precision) — see note in decimalData helper above.
const KLINE_FIELDS = [
  new Field('code', new Utf8()),
  new Field('trade_date', new DateDay()),
  new Field('open_qfq', new Decimal(4, 20)),
  new Field('high_qfq', new Decimal(4, 20)),
  new Field('low_qfq', new Decimal(4, 20)),
  new Field('close_qfq', new Decimal(4, 20)),
  new Field('volume', new Int64()),
  new Field('amount', new Decimal(2, 20)),
  new Field('turnover_rate', new Decimal(6, 12)),
  new Field('ma5', new Decimal(4, 20)),
  new Field('ma10', new Decimal(4, 20)),
  new Field('ma20', new Decimal(4, 20)),
  new Field('ma60', new Decimal(4, 20)),
];
const KLINE_SCHEMA = new Schema(KLINE_FIELDS);

// close_qfq = 1234.5600  → unscaled = 12345600 at scale 4
// open_qfq  = 1230.0000  → unscaled = 12300000
// high_qfq  = 1250.0000  → unscaled = 12500000
// low_qfq   = 1220.0000  → unscaled = 12200000
// turnover_rate = 0.15   → unscaled = 150000  at scale 6
// ma5       = 1220.0000  → unscaled = 12200000
const TRADE_DATE = new Date('2026-05-06'); // ms since epoch = 1778025600000

function buildSingleRowTable(code: string): Table {
  const childData = [
    utf8Data(code),
    dateDayData(TRADE_DATE),
    decimalData(12_300_000, 4),   // open_qfq
    decimalData(12_500_000, 4),   // high_qfq
    decimalData(12_200_000, 4),   // low_qfq
    decimalData(12_345_600, 4),   // close_qfq = 1234.56
    int64Data(1_000_000),          // volume
    decimalData(1_234_560_000, 2), // amount = 12345600.00
    decimalData(150_000, 6),       // turnover_rate = 0.15
    decimalData(12_200_000, 4),   // ma5 = 1220.00
    decimalData(12_100_000, 4),   // ma10 = 1210.00
    decimalData(12_000_000, 4),   // ma20 = 1200.00
    decimalData(11_800_000, 4),   // ma60 = 1180.00
  ];
  const structData = makeData({
    type: new Struct(KLINE_FIELDS),
    length: 1,
    children: childData,
  });
  const rb = new RecordBatch(KLINE_SCHEMA, structData);
  return new Table([rb]);
}

// ---------------------------------------------------------------------------
// Tests — arrowTableToKlineBars
// ---------------------------------------------------------------------------

describe('arrowTableToKlineBars', () => {
  it('decodes close_qfq decimal128(20,4) unscaled 12345600 → 1234.56 (×10000 regression)', () => {
    const table = buildSingleRowTable('600519');
    const bars = arrowTableToKlineBars(table);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.close).toBeCloseTo(1234.56, 2);
  });

  it('decodes open_qfq correctly', () => {
    const bars = arrowTableToKlineBars(buildSingleRowTable('600519'));
    expect(bars[0]!.open).toBeCloseTo(1230.0, 2);
  });

  it('decodes high_qfq correctly', () => {
    const bars = arrowTableToKlineBars(buildSingleRowTable('600519'));
    expect(bars[0]!.high).toBeCloseTo(1250.0, 2);
  });

  it('decodes low_qfq correctly', () => {
    const bars = arrowTableToKlineBars(buildSingleRowTable('600519'));
    expect(bars[0]!.low).toBeCloseTo(1220.0, 2);
  });

  it('decodes turnover_rate decimal128(12,6) correctly', () => {
    const bars = arrowTableToKlineBars(buildSingleRowTable('600519'));
    expect(bars[0]!.turnoverRate).toBeCloseTo(0.15, 4);
  });

  it('decodes ma5 correctly', () => {
    const bars = arrowTableToKlineBars(buildSingleRowTable('600519'));
    expect(bars[0]!.ma5).toBeCloseTo(1220.0, 2);
  });

  it('decodes trade_date DateDay to YYYY-MM-DD string', () => {
    const bars = arrowTableToKlineBars(buildSingleRowTable('600519'));
    expect(bars[0]!.date).toBe('2026-05-06');
  });

  it('returns empty array for an empty table', () => {
    const empty = new Table();
    expect(arrowTableToKlineBars(empty)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — arrowTableToKlineBarsByCode
// ---------------------------------------------------------------------------

describe('arrowTableToKlineBarsByCode', () => {
  it('groups bars by code key', () => {
    // Build a two-row table with two different codes
    const codeBuilder = new Utf8Builder({ type: new Utf8() });
    codeBuilder.append('600519');
    codeBuilder.append('000001');

    const dateBuilder = new DateDayBuilder({ type: new DateDay() });
    dateBuilder.append(TRADE_DATE);
    dateBuilder.append(TRADE_DATE);

    function decBuilder2(v1: number, v2: number, scale: number, precision = 20): Data {
      const b = new DecimalBuilder({ type: new Decimal(scale, precision) });
      const u1 = new Uint32Array(4); u1[0] = v1; b.append(u1);
      const u2 = new Uint32Array(4); u2[0] = v2; b.append(u2);
      const v = b.finish().toVector() as unknown as { data: Data[] };
      return v.data[0]!;
    }
    function i64Builder2(v: number): Data {
      const b = new Int64Builder({ type: new Int64() });
      b.append(BigInt(v)); b.append(BigInt(v));
      const vec = b.finish().toVector() as unknown as { data: Data[] };
      return vec.data[0]!;
    }

    const schema = new Schema(KLINE_FIELDS);
    const codeVec = codeBuilder.finish().toVector() as unknown as { data: Data[] };
    const dateVec = dateBuilder.finish().toVector() as unknown as { data: Data[] };
    const structData = makeData({
      type: new Struct(KLINE_FIELDS),
      length: 2,
      children: [
        codeVec.data[0]!,
        dateVec.data[0]!,
        decBuilder2(12_300_000, 11_000_000, 4, 20),
        decBuilder2(12_500_000, 11_200_000, 4, 20),
        decBuilder2(12_200_000, 10_800_000, 4, 20),
        decBuilder2(12_345_600, 11_100_000, 4, 20),
        i64Builder2(1_000_000),
        decBuilder2(1_234_560_000, 111_000_000, 2, 20),
        decBuilder2(150_000, 100_000, 6, 12),
        decBuilder2(12_200_000, 11_000_000, 4, 20),
        decBuilder2(12_100_000, 10_900_000, 4, 20),
        decBuilder2(12_000_000, 10_800_000, 4, 20),
        decBuilder2(11_800_000, 10_600_000, 4, 20),
      ],
    });
    const rb = new RecordBatch(schema, structData);
    const table = new Table([rb]);
    const result = arrowTableToKlineBarsByCode(table);
    expect(Object.keys(result).sort()).toEqual(['000001', '600519']);
    expect(result['600519']).toHaveLength(1);
    expect(result['000001']).toHaveLength(1);
    expect(result['600519']![0]!.close).toBeCloseTo(1234.56, 2);
    expect(result['000001']![0]!.close).toBeCloseTo(1110.0, 2);
  });

  it('returns empty object for an empty table', () => {
    const empty = new Table();
    expect(arrowTableToKlineBarsByCode(empty)).toEqual({});
  });
});
