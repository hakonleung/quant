/**
 * Cross-process DTO for stock metadata. Mirrors the Python
 * {@link services/py/quant_core/domain/types/stock.py} `StockMeta`
 * dataclass — both ends are validated against the same shape.
 *
 * Serialization choices (must match the Python side):
 * - Decimal share counts → strings (no float rounding).
 * - Dates → ISO `YYYY-MM-DD` strings.
 * - Datetimes → ISO 8601 with explicit UTC offset.
 * - Closed string unions for `exchange` / `board` / `status`.
 */

import { z } from 'zod';

export const ExchangeSchema = z.enum(['SH', 'SZ', 'BJ']);
export type Exchange = z.infer<typeof ExchangeSchema>;

export const BoardSchema = z.enum(['MAIN', 'CHINEXT', 'STAR', 'BSE']);
export type Board = z.infer<typeof BoardSchema>;

export const StockStatusSchema = z.enum(['NORMAL', 'ST', 'STAR_ST', 'SUSPENDED', 'DELISTED']);
export type StockStatus = z.infer<typeof StockStatusSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const isoDateTime = z.string().datetime({ offset: true });
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected decimal as string');

export const StockMetaDtoSchema = z
  .object({
    code: z.string().min(1),
    name: z.string(),
    name_pinyin: z.string(),
    exchange: ExchangeSchema,
    board: BoardSchema,
    industry_sw_l1: z.string(),
    industry_sw_l2: z.string(),
    industry_sw_l3: z.string(),
    list_date: isoDate,
    delist_date: isoDate.nullable(),
    total_share: decimalString,
    float_share: decimalString,
    status: StockStatusSchema,
    updated_at: isoDateTime,
  })
  .strict();

export type StockMetaDto = z.infer<typeof StockMetaDtoSchema>;
