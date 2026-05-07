import { isOriginAllowed } from '../../../src/modules/socket/cors-origin.js';

describe('isOriginAllowed', () => {
  it('allows undefined origin (curl, health checks)', () => {
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed('')).toBe(true);
  });

  it('allows loopback hostnames regardless of port', () => {
    expect(isOriginAllowed('http://localhost:3000')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000')).toBe(true);
    expect(isOriginAllowed('http://localhost:9999')).toBe(true);
  });

  it('allows same-host different-port given the request host header', () => {
    expect(isOriginAllowed('http://192.168.1.42:3000', '192.168.1.42:3001')).toBe(true);
    expect(isOriginAllowed('http://my.lan:3000', 'my.lan:3001')).toBe(true);
  });

  it('rejects different host without an explicit allowlist entry', () => {
    expect(isOriginAllowed('http://evil.example.com:3000', '127.0.0.1:3001')).toBe(false);
    expect(isOriginAllowed('https://random.org')).toBe(false);
  });

  it('rejects malformed origins', () => {
    expect(isOriginAllowed('not-a-url')).toBe(false);
  });
});
