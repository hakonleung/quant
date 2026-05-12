import type {
  TimeSeriesReadQuery,
  TimeSeriesStore,
} from '../../src/common/storage/ports/time-series-store.port.js';

export class InMemoryTimeSeriesStore<Row extends { code: string; ts: Date }>
  implements TimeSeriesStore<Row>
{
  private readonly rows = new Map<string, Map<number, Row>>();

  async read(query: TimeSeriesReadQuery<Row>): Promise<readonly Row[]> {
    const codes = query.entityKeys ?? Array.from(this.rows.keys());
    const start = query.start?.getTime() ?? -Infinity;
    const end = query.end?.getTime() ?? Infinity;
    const out: Row[] = [];
    for (const code of codes) {
      const bucket = this.rows.get(code);
      if (bucket === undefined) continue;
      const sorted = Array.from(bucket.values())
        .filter((r) => {
          const t = r.ts.getTime();
          return t >= start && t <= end;
        })
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
      const tail = query.tail !== undefined ? sorted.slice(-query.tail) : sorted;
      for (const row of tail) out.push(this.project(row, query.columns));
    }
    out.sort((a, b) => {
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      return a.ts.getTime() - b.ts.getTime();
    });
    return out;
  }

  async appendBars(rows: readonly Row[]): Promise<void> {
    for (const row of rows) {
      let bucket = this.rows.get(row.code);
      if (bucket === undefined) {
        bucket = new Map();
        this.rows.set(row.code, bucket);
      }
      bucket.set(row.ts.getTime(), row);
    }
  }

  async lastTimestamp(entityKey: string): Promise<Date | null> {
    const bucket = this.rows.get(entityKey);
    if (bucket === undefined || bucket.size === 0) return null;
    let max = -Infinity;
    for (const ts of bucket.keys()) if (ts > max) max = ts;
    return new Date(max);
  }

  async lastTimestamps(entityKeys: readonly string[]): Promise<ReadonlyMap<string, Date>> {
    const out = new Map<string, Date>();
    for (const k of entityKeys) {
      const last = await this.lastTimestamp(k);
      if (last !== null) out.set(k, last);
    }
    return out;
  }

  async compact(): Promise<void> {
    // no-op
  }

  private project(row: Row, columns: readonly (keyof Row & string)[] | undefined): Row {
    if (columns === undefined) return row;
    const out: Record<string, unknown> = {};
    for (const c of columns) out[c] = row[c];
    return out as Row;
  }
}
