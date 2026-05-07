import { loadChannelConfig } from '../../../src/modules/channel/config/channel.config.js';

describe('loadChannelConfig', () => {
  it('returns an empty enabled set when CHANNEL_ENABLED is unset', () => {
    const cfg = loadChannelConfig({});
    expect(cfg.enabled.size).toBe(0);
    expect(cfg.slack).toBeNull();
    expect(cfg.feishu).toBeNull();
  });

  it('parses dryRun + redis defaults', () => {
    const cfg = loadChannelConfig({ CHANNEL_DRY_RUN: 'true' });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(cfg.bullPrefix).toBe('quant:channel');
  });

  it('rejects slack=enabled without bot token', () => {
    expect(() => loadChannelConfig({ CHANNEL_ENABLED: 'slack' })).toThrow(
      /CHANNEL_SLACK_BOT_TOKEN is missing/,
    );
  });

  it('builds a slack config when secrets are present', () => {
    const cfg = loadChannelConfig({
      CHANNEL_ENABLED: 'slack',
      CHANNEL_SLACK_BOT_TOKEN: 'xoxb-test',
      CHANNEL_SLACK_APP_TOKEN: 'xapp-test',
      CHANNEL_SLACK_DEFAULT_CHANNEL: '#alerts',
    });
    expect(cfg.enabled.has('slack')).toBe(true);
    expect(cfg.slack?.botToken).toBe('xoxb-test');
    expect(cfg.slack?.appToken).toBe('xapp-test');
    expect(cfg.slack?.defaultChannel).toBe('#alerts');
  });

  it('rejects feishu=enabled without app id/secret', () => {
    expect(() => loadChannelConfig({ CHANNEL_ENABLED: 'feishu' })).toThrow(
      /CHANNEL_FEISHU_APP_ID/,
    );
  });

  it('ignores unknown channel ids in CHANNEL_ENABLED', () => {
    const cfg = loadChannelConfig({ CHANNEL_ENABLED: 'imaginary,slack', CHANNEL_SLACK_BOT_TOKEN: 'xoxb' });
    expect(cfg.enabled.has('slack')).toBe(true);
    expect(cfg.enabled.size).toBe(1);
  });
});
