import {
  buildInstructionAsyncCompletedCard,
  buildInstructionAsyncStartedCard,
  buildInstructionReplyCard,
  pickCard,
  stripSlackMrkdwn,
} from '../../../src/modules/channel/adapters/feishu-card.js';

describe('feishu-card.pickCard', () => {
  it('returns null for unknown kinds', () => {
    expect(pickCard({ kind: 'random.thing', text: 'hello' })).toBeNull();
    expect(pickCard({ text: 'no kind' })).toBeNull();
  });

  it('routes the four supported kinds to their builders', () => {
    expect(pickCard({ kind: 'watch.hit', text: 'WATCH 600000\n+3.21%\nma5 cross' })).not.toBeNull();
    expect(
      pickCard({
        kind: 'instruction.reply',
        text: 'ok',
        meta: { ok: true, instructionId: 'help' },
      }),
    ).not.toBeNull();
    expect(
      pickCard({
        kind: 'instruction.async.started',
        text: '▶ /analyze queued',
        meta: { instructionId: 'analyze' },
      }),
    ).not.toBeNull();
    expect(
      pickCard({
        kind: 'instruction.async.completed',
        text: 'analysis done',
        meta: { ok: true, instructionId: 'analyze', durationMs: 4321 },
      }),
    ).not.toBeNull();
  });
});

describe('buildInstructionReplyCard', () => {
  it('uses green header + checkmark on success', () => {
    const card = buildInstructionReplyCard('focused 600519', {
      ok: true,
      instructionId: 'focus',
    });
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toBe('✓ /focus');
  });

  it('uses red header + error code on failure', () => {
    const card = buildInstructionReplyCard('[validation] code: bad', {
      ok: false,
      instructionId: 'focus',
      code: 'validation',
    });
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toBe('✗ /focus (validation)');
  });

  it('falls back to a generic ✗ title when code is missing', () => {
    const card = buildInstructionReplyCard('boom', { ok: false, instructionId: 'focus' });
    expect(card.header.title.content).toBe('✗ /focus');
  });

  it('truncates body text past the card limit', () => {
    const long = 'x'.repeat(5000);
    const card = buildInstructionReplyCard(long, { ok: true, instructionId: 'focus' });
    // Body is rendered via the cardkit-v2 `markdown` element (no `text`
    // wrapper) so triple-backtick fences render as real monospace blocks
    // — see the `bodyMarkdownElement` comment in feishu-card.ts.
    const elem = card.elements[0] as { tag: 'markdown'; content: string };
    expect(elem.tag).toBe('markdown');
    expect(elem.content.endsWith('…(truncated)')).toBe(true);
    expect(elem.content.length).toBeLessThanOrEqual(3000);
  });
});

describe('buildInstructionAsyncStartedCard', () => {
  it('renders an orange "queued" header', () => {
    const card = buildInstructionAsyncStartedCard('▶ /analyze queued (jobId=abc)', {
      instructionId: 'analyze',
    });
    expect(card.header.template).toBe('orange');
    expect(card.header.title.content).toBe('▶ /analyze queued');
  });
});

describe('buildInstructionAsyncCompletedCard', () => {
  it('renders a green header + duration footer on success', () => {
    const card = buildInstructionAsyncCompletedCard('analysis done', {
      ok: true,
      instructionId: 'analyze',
      durationMs: 4321,
    });
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toBe('✓ /analyze done');
    const note = card.elements[1] as { tag: string; elements: { content: string }[] };
    expect(note.tag).toBe('note');
    expect(note.elements[0]?.content).toBe('took 4.32s');
  });

  it('omits the duration footer when not provided', () => {
    const card = buildInstructionAsyncCompletedCard('done', {
      ok: true,
      instructionId: 'analyze',
    });
    expect(card.elements).toHaveLength(1);
  });

  it('renders a red header on failure with the error code', () => {
    const card = buildInstructionAsyncCompletedCard('boom', {
      ok: false,
      instructionId: 'analyze',
      code: 'handler',
    });
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toBe('✗ /analyze (handler)');
  });
});

describe('stripSlackMrkdwn (regression)', () => {
  it('drops Slack square-emoji shortcodes and bold/italic markers', () => {
    expect(stripSlackMrkdwn('*hello* :white_square: _world_')).toBe('hello ⬜ world');
  });
});

describe('pickCard — agent kinds', () => {
  it('renders the paid-confirm card with the original q in the body and confirm button', () => {
    const card = pickCard({
      kind: 'agent.paid_confirm',
      text: '',
      meta: { agentQ: '看茅台估值', instructionId: 'agent' },
    });
    expect(card).not.toBeNull();
    expect(card?.header.template).toBe('purple');
    expect(card?.header.title.content).toContain('agent');
    // q appears in the div body text
    const divElem = (card as unknown as { elements: unknown[] })?.elements[0] as {
      tag: string;
      text: { content: string };
    };
    expect(divElem.text.content).toContain('看茅台估值');
    // confirm button value carries action=confirm + agentQ as a plain object
    // (Feishu spec requires Object — strings are not reliably round-tripped).
    const actionElem = (card as unknown as { elements: unknown[] })?.elements[1] as {
      tag: string;
      actions: { tag: string; type: string; value: Record<string, unknown> }[];
    };
    expect(actionElem.tag).toBe('action');
    const confirmBtn = actionElem.actions[0];
    expect(confirmBtn?.value['action']).toBe('confirm');
    expect(confirmBtn?.value['agentQ']).toBe('看茅台估值');
  });

  it('renders the tool-proposal card with approve + cancel buttons carrying correlationId', () => {
    const card = pickCard({
      kind: 'agent.tool_proposal',
      text: '  1. /screen "近5日银行" — NL 选股',
      meta: { correlationId: 'abc-123' },
    });
    expect(card).not.toBeNull();
    expect(card?.header.template).toBe('purple');
    const actionElem = (card as unknown as { elements: unknown[] })?.elements[1] as {
      tag: string;
      actions: { tag: string; type: string; value: Record<string, unknown> }[];
    };
    expect(actionElem.tag).toBe('action');
    expect(actionElem.actions[0]?.value['action']).toBe('confirm');
    expect(actionElem.actions[0]?.value['correlationId']).toBe('abc-123');
    expect(actionElem.actions[1]?.value['action']).toBe('cancel');
    expect(actionElem.actions[1]?.value['correlationId']).toBe('abc-123');
  });

  it('preserves embedded double-quotes in agentQ via the object button value', () => {
    const card = pickCard({
      kind: 'agent.paid_confirm',
      text: '',
      meta: { agentQ: 'find "high vol" stocks', instructionId: 'agent' },
    });
    const actionElem = (card as unknown as { elements: unknown[] })?.elements[1] as {
      tag: string;
      actions: { value: Record<string, unknown> }[];
    };
    // Object payload preserves the original string intact — Feishu serializes
    // it on the wire and our adapter parses it back to the same shape.
    expect(actionElem.actions[0]?.value['agentQ']).toBe('find "high vol" stocks');
  });
});
