/**
 * Tests for the /sector (list) cell — handler + renderer.
 *
 * Covers:
 *   - empty list → "no sectors visible"
 *   - mixed published / own / others' sectors
 *   - error envelope passes through
 *   - data shape (typed result from handler)
 */

import type {
  InstructionEnvelope,
  ResultOf,
  SectorListRow,
} from '@quant/shared';

import { buildSectorCell } from '../../../src/modules/instruction-center/cells/sector.cell.js';
import { renderSector } from '../../../src/modules/instruction-center/cells/sector.render.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { SectorsService } from '../../../src/modules/sectors/sectors.service.js';

type SectorListResult = ResultOf<'sector'>;

interface FakeSector {
  readonly id: string;
  readonly name: string;
  readonly published: boolean;
  readonly codes: readonly string[];
  readonly createdBy: string;
}

function fakeSectors(visible: readonly FakeSector[]): SectorsService {
  return {
    listVisibleTo: () => visible,
  } as unknown as SectorsService;
}

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

describe('buildSectorCell.handler', () => {
  it('returns rows=[] when no sectors visible', async () => {
    const cell = buildSectorCell({ sectors: fakeSectors([]) });
    const r = await cell.handler({}, ctx);
    expect(r.rows).toEqual([]);
  });

  it('maps sectors to typed rows, marking own sectors with isOwn=true', async () => {
    const cell = buildSectorCell({
      sectors: fakeSectors([
        { id: 's1', name: 'mine', published: false, codes: ['600519'], createdBy: 'me' },
        {
          id: 's2',
          name: 'shared',
          published: true,
          codes: ['000001', '600000'],
          createdBy: 'someone-else',
        },
      ]),
    });
    const r = await cell.handler({}, ctx);
    expect(r.rows).toEqual<SectorListRow[]>([
      { id: 's1', name: 'mine', published: false, codeCount: 1, createdBy: 'me', isOwn: true },
      {
        id: 's2',
        name: 'shared',
        published: true,
        codeCount: 2,
        createdBy: 'someone-else',
        isOwn: false,
      },
    ]);
  });
});

describe('renderSector', () => {
  function okEnv(rows: SectorListRow[]): InstructionEnvelope<SectorListResult> {
    return { ok: true, data: { rows } };
  }

  it('renders "no sectors visible" on empty rows', () => {
    const out = renderSector(okEnv([]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('no sectors visible');
    expect(out.output.meta).toBeUndefined();
  });

  it('renders a table with [PUB] marker, padded id/name, count, and "me" tag', () => {
    const out = renderSector(
      okEnv([
        { id: 's1', name: 'mine', published: false, codeCount: 1, createdBy: 'me', isOwn: true },
        {
          id: 's2',
          name: 'shared',
          published: true,
          codeCount: 2,
          createdBy: 'someone-else',
          isOwn: false,
        },
      ]),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('sectors (2):');
    expect(out.output.text).toContain('[PUB]');
    expect(out.output.text).toContain('by me');
    expect(out.output.text).toContain('by someone-else');
    const meta = out.output.meta as {
      tableSections: { rows: { pub: string; id: string; by: string }[] }[];
      tablesSubheader: string;
    };
    expect(meta.tablesSubheader).toBe('sectors (2)');
    const tableRows = meta.tableSections[0]?.rows ?? [];
    expect(tableRows[0]?.pub).toBe('');
    expect(tableRows[0]?.by).toBe('me');
    expect(tableRows[1]?.pub).toBe('✓');
    expect(tableRows[1]?.by).toBe('someone-else');
  });

  it('passes through error envelope verbatim', () => {
    const out = renderSector({
      ok: false,
      error: { code: 'forbidden', message: 'nope' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ code: 'forbidden', message: 'nope' });
  });
});
