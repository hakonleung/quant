import { loadInstructionConfig } from '../../../src/modules/instruction/instruction.config.js';

describe('loadInstructionConfig', () => {
  it('defaults to fully open allowlist + debug disabled', () => {
    const cfg = loadInstructionConfig({});
    expect(cfg.imAllowlist.size).toBe(0);
    expect(cfg.debugInstructionsEnabled).toBe(false);
  });

  it('parses comma-separated allowlist with whitespace tolerance', () => {
    const cfg = loadInstructionConfig({
      INSTRUCTION_IM_ALLOWLIST: 'feishu:ou_a, slack:U_b , ',
    });
    expect([...cfg.imAllowlist].sort()).toEqual(['feishu:ou_a', 'slack:U_b']);
  });

  it('treats `1` / `true` / `yes` / `on` as enabled', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadInstructionConfig({ INSTRUCTION_DEBUG_ENABLED: v }).debugInstructionsEnabled).toBe(
        true,
      );
    }
  });

  it('treats empty / `0` / `false` / `no` / `off` as disabled', () => {
    for (const v of ['', '0', 'false', 'no', 'off']) {
      expect(loadInstructionConfig({ INSTRUCTION_DEBUG_ENABLED: v }).debugInstructionsEnabled).toBe(
        false,
      );
    }
  });

  it('rejects garbage debug values with a clear error', () => {
    expect(() => loadInstructionConfig({ INSTRUCTION_DEBUG_ENABLED: 'maybe' })).toThrow(
      /INSTRUCTION_DEBUG_ENABLED/u,
    );
  });
});
