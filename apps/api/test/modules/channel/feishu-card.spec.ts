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
    const elem = card.elements[0] as { text: { content: string } };
    expect(elem.text.content.endsWith('…(truncated)')).toBe(true);
    expect(elem.text.content.length).toBeLessThanOrEqual(3000);
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
