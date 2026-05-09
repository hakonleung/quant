import {
  buildInstructionAsyncCompletedBlocks,
  buildInstructionAsyncStartedBlocks,
  buildInstructionReplyBlocks,
  pickBlocks,
} from '../../../src/modules/channel/adapters/slack-card.js';

interface HeaderBlock {
  readonly type: 'header';
  readonly text: { readonly type: 'plain_text'; readonly text: string };
}

interface SectionBlock {
  readonly type: 'section';
  readonly text: { readonly type: 'mrkdwn'; readonly text: string };
}

interface ContextBlock {
  readonly type: 'context';
  readonly elements: readonly { readonly type: 'mrkdwn'; readonly text: string }[];
}

function asHeader(b: unknown): HeaderBlock {
  return b as HeaderBlock;
}
function asSection(b: unknown): SectionBlock {
  return b as SectionBlock;
}
function asContext(b: unknown): ContextBlock {
  return b as ContextBlock;
}

describe('slack-card.pickBlocks', () => {
  it('returns null for unknown kinds', () => {
    expect(pickBlocks({ text: 'hi' })).toBeNull();
    expect(pickBlocks({ kind: 'random.thing', text: 'hi' })).toBeNull();
  });

  it('routes the four supported kinds', () => {
    expect(pickBlocks({ kind: 'watch.hit', text: 'WATCH 600000\n+3.21%' })).not.toBeNull();
    expect(
      pickBlocks({
        kind: 'instruction.reply',
        text: 'ok',
        meta: { ok: true, instructionId: 'help' },
      }),
    ).not.toBeNull();
    expect(
      pickBlocks({
        kind: 'instruction.async.started',
        text: '▶ /analyze queued',
        meta: { instructionId: 'analyze' },
      }),
    ).not.toBeNull();
    expect(
      pickBlocks({
        kind: 'instruction.async.completed',
        text: 'done',
        meta: { ok: true, instructionId: 'analyze', durationMs: 1234 },
      }),
    ).not.toBeNull();
  });
});

describe('buildInstructionReplyBlocks', () => {
  it('renders ✓ header on success', () => {
    const blocks = buildInstructionReplyBlocks('focused 600519', {
      ok: true,
      instructionId: 'focus',
    });
    expect(asHeader(blocks.blocks[0]).text.text).toBe('✓ /focus');
    expect(asSection(blocks.blocks[1]).text.text).toBe('focused 600519');
  });

  it('renders ✗ header with code on failure', () => {
    const blocks = buildInstructionReplyBlocks('bad', {
      ok: false,
      instructionId: 'focus',
      code: 'validation',
    });
    expect(asHeader(blocks.blocks[0]).text.text).toBe('✗ /focus (validation)');
  });

  it('truncates oversized section text', () => {
    const blocks = buildInstructionReplyBlocks('x'.repeat(5000), {
      ok: true,
      instructionId: 'focus',
    });
    const section = asSection(blocks.blocks[1]);
    expect(section.text.text.endsWith('…(truncated)')).toBe(true);
    expect(section.text.text.length).toBeLessThanOrEqual(3000);
  });
});

describe('async block builders', () => {
  it('started carries a "▶ /<id> queued" header', () => {
    const blocks = buildInstructionAsyncStartedBlocks('▶ /analyze queued (jobId=x)', {
      instructionId: 'analyze',
    });
    expect(asHeader(blocks.blocks[0]).text.text).toBe('▶ /analyze queued');
  });

  it('completed appends a context note with the duration', () => {
    const blocks = buildInstructionAsyncCompletedBlocks('done', {
      ok: true,
      instructionId: 'analyze',
      durationMs: 4321,
    });
    expect(asHeader(blocks.blocks[0]).text.text).toBe('✓ /analyze done');
    expect(asContext(blocks.blocks[2]).elements[0]?.text).toBe('took 4.32s');
  });

  it('completed without duration omits the note block', () => {
    const blocks = buildInstructionAsyncCompletedBlocks('done', {
      ok: true,
      instructionId: 'analyze',
    });
    expect(blocks.blocks).toHaveLength(2);
  });
});
