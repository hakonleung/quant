/**
 * Pure-rendering tests for the /usr cell. Covers:
 *   - identity-only result (no LLM calls yet)
 *   - full ledger snapshot (today/month/total + byScope + byModel)
 *   - error envelope passes through
 *   - optional identity fields appear only when set
 */

import {
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import { renderUsr } from '../../../src/modules/instruction-center/cells/usr.render.js';

type UsrResult = ResultOf<'usr'>;

const baseIdentity: UsrResult['identity'] = {
  userId: 'u-1',
  role: 'admin',
  source: 'im',
};

function okEnvelope(data: UsrResult): InstructionEnvelope<UsrResult> {
  return { ok: true, data };
}

describe('renderUsr', () => {
  it('emits identity table only when ledger is null', () => {
    const out = renderUsr(okEnvelope({ identity: baseIdentity, ledger: null }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('user_id');
    expect(out.output.text).toContain('u-1');
    expect(out.output.text).toContain('(no calls yet)');
    expect(out.output.meta).toBeDefined();
    const sections = (out.output.meta as { tableSections: Record<string, unknown>[] })
      .tableSections;
    expect(sections).toHaveLength(2); // identity + ledger placeholder
    expect(sections[0]?.['title']).toBe('身份');
    expect(sections[1]?.['title']).toBe('LLM 使用');
  });

  it('emits full ledger sections when present', () => {
    const out = renderUsr(
      okEnvelope({
        identity: baseIdentity,
        ledger: {
          today: { label: 'today', callCount: 1, input: 10, output: 20, total: 30 },
          month: { label: 'month', callCount: 3, input: 30, output: 60, total: 90 },
          total: { label: 'total', callCount: 5, input: 50, output: 100, total: 150 },
          byScope: [{ label: 'agent', callCount: 5, input: 50, output: 100, total: 150 }],
          byModel: [{ label: 'gpt-4', callCount: 5, input: 50, output: 100, total: 150 }],
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('today');
    expect(out.output.text).toContain('按 scope 拆分');
    expect(out.output.text).toContain('按 model 拆分');
    const sections = (out.output.meta as { tableSections: Record<string, unknown>[] })
      .tableSections;
    expect(sections).toHaveLength(4); // identity + ledger + byScope + byModel
  });

  it('surfaces every optional identity field when set', () => {
    const out = renderUsr(
      okEnvelope({
        identity: {
          ...baseIdentity,
          channel: 'feishu',
          imId: 'feishu:abc',
          mappedFromUserId: 'feishu:abc',
          imBootstrap: true,
        },
        ledger: null,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('channel');
    expect(out.output.text).toContain('feishu');
    expect(out.output.text).toContain('im_id');
    expect(out.output.text).toContain('mapped_from');
    expect(out.output.text).toContain('AUTH_ADMIN_USER_IDS');
    expect(out.output.text).toContain('bootstrap');
  });

  it('omits optional fields when not set', () => {
    const out = renderUsr(okEnvelope({ identity: baseIdentity, ledger: null }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).not.toContain('channel');
    expect(out.output.text).not.toContain('im_id');
    expect(out.output.text).not.toContain('bootstrap');
  });

  it('passes through error envelopes verbatim', () => {
    const out = renderUsr({ ok: false, error: { code: 'handler', message: 'boom' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('handler');
    expect(out.error.message).toBe('boom');
  });

  it('hides byScope / byModel sections when their arrays are empty', () => {
    const out = renderUsr(
      okEnvelope({
        identity: baseIdentity,
        ledger: {
          today: { label: 'today', callCount: 0, input: 0, output: 0, total: 0 },
          month: { label: 'month', callCount: 0, input: 0, output: 0, total: 0 },
          total: { label: 'total', callCount: 1, input: 1, output: 1, total: 2 },
          byScope: [],
          byModel: [],
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).not.toContain('按 scope 拆分');
    expect(out.output.text).not.toContain('按 model 拆分');
    const sections = (out.output.meta as { tableSections: Record<string, unknown>[] })
      .tableSections;
    expect(sections).toHaveLength(2);
  });
});
