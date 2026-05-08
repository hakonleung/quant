import { redirect } from 'next/navigation.js';

import { getSession } from '../../lib/auth/session.js';

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  readonly searchParams?: Promise<{ readonly error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps): Promise<JSX.Element> {
  const existing = await getSession();
  if (existing !== null) redirect('/');
  const params = (await searchParams) ?? {};
  const error = params.error;
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0b0d10',
        color: '#e5e7eb',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          background: '#11151b',
          border: '1px solid #1f2937',
          borderRadius: 12,
          padding: '32px 36px',
          width: 360,
          boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
        }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>登录到 Quant</h1>
        <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 24 }}>
          使用飞书账号继续。仅用于将你的本地账本、自选股和系统配置与你的身份绑定。
        </p>
        <a
          href="/api/auth/feishu/start"
          style={{
            display: 'block',
            textAlign: 'center',
            padding: '10px 16px',
            background: '#2563eb',
            color: '#fff',
            borderRadius: 8,
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          用飞书登录
        </a>
        {error !== undefined && (
          <p style={{ marginTop: 16, fontSize: 12, color: '#ef4444' }}>登录失败：{error}</p>
        )}
      </div>
    </main>
  );
}
