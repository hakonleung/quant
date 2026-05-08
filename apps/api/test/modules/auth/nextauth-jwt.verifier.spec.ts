import { createHmac } from 'node:crypto';

import { NextauthJwtVerifier } from '../../../src/modules/auth/adapters/nextauth-jwt.verifier.js';

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function sign(payload: Record<string, unknown>, secret: string): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${base64UrlEncode(sig)}`;
}

const SECRET = 'test-secret';

describe('NextauthJwtVerifier', () => {
  it('decodes a valid HS256 token and surfaces claims', async () => {
    const v = new NextauthJwtVerifier(SECRET);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = sign(
      { userId: 'feishu:ou_alice', displayName: 'Alice', iat: 0, exp },
      SECRET,
    );
    const claims = await v.verify(token);
    expect(claims).toEqual({
      userId: 'feishu:ou_alice',
      displayName: 'Alice',
      issuedAt: 0,
      expiresAt: exp,
    });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const v = new NextauthJwtVerifier(SECRET);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = sign({ userId: 'feishu:ou_x', exp }, 'other-secret');
    expect(await v.verify(token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const v = new NextauthJwtVerifier(SECRET);
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = sign({ userId: 'feishu:ou_x', exp }, SECRET);
    expect(await v.verify(token)).toBeNull();
  });

  it('returns null when the secret is unset', async () => {
    const v = new NextauthJwtVerifier(null);
    expect(await v.verify('whatever')).toBeNull();
  });

  it('returns null on malformed input', async () => {
    const v = new NextauthJwtVerifier(SECRET);
    expect(await v.verify('not-a-jwt')).toBeNull();
    expect(await v.verify('')).toBeNull();
  });
});
