/**
 * Cross-process DTO for stock metadata. Mirrors the Python
 * {@link services/py/quant_core/domain/types/stock.py} `StockMeta`
 * dataclass — both ends are validated against the same shape.
 *
 * Serialization choices (must match the Python side):
 * - `code` is the bare 6-digit string (e.g. `"600519"`). The exchange is
 *   not stored on the row; consumers that need it derive it from the
 *   prefix at the call site.
 * - Dates → ISO `YYYY-MM-DD` strings.
 * - Datetimes → ISO 8601 with explicit UTC offset.
 * - `industries` → comma-joined string from coarse → fine, e.g.
 *   `"食品饮料,白酒"`. Empty string allowed.
 * - `float_pct` → decimal string in `[0, 1]` (e.g. `"1"`, `"0.85"`).
 *   Defaults to `"1"` (fully tradable) for sources that don't expose it.
 */

import { z } from 'zod';

const sixDigitCode = z.string().regex(/^\d{6}$/, 'expected 6-digit numeric code');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const isoDateTime = z.string().datetime({ offset: true });
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected decimal as string');

export const StockMetaDtoSchema = z
  .object({
    code: sixDigitCode,
    name: z.string(),
    name_pinyin: z.string(),
    industries: z.string(),
    list_date: isoDate,
    float_pct: decimalString,
    updated_at: isoDateTime,
  })
  .strict();

export type StockMetaDto = z.infer<typeof StockMetaDtoSchema>;
