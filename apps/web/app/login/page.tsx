import { Box } from '@chakra-ui/react';
import { redirect } from 'next/navigation.js';

import { getSession } from '../../lib/auth/session.js';

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  readonly searchParams?: Promise<{ readonly error?: string }>;
}

/**
 * RSC: cannot use `useTokenColor` here (hooks are client-only). Chakra
 * semantic-token props compile to CSS vars at build time, so the same
 * `[data-theme]` flip auto-themes the page. The login CTA is a native
 * `<a>` with CSS-var inline styles — Chakra's `Box as="a"` polymorphism
 * doesn't surface `href` cleanly, and the single inline style block
 * keeps this file honest about being a static RSC.
 */
export default async function LoginPage({ searchParams }: LoginPageProps): Promise<JSX.Element> {
  const existing = await getSession();
  if (existing !== null) redirect('/');
  const params = (await searchParams) ?? {};
  return (
    <Box
      as="main"
      minH="100vh"
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="bg"
      color="ink"
      fontFamily="body"
    >
      <LoginCard error={params.error} />
    </Box>
  );
}

function LoginCard({ error }: { readonly error: string | undefined }): JSX.Element {
  return (
    <Box
      bg="panel"
      borderWidth="1px"
      borderColor="line"
      borderRadius="12px"
      px="36px"
      py="32px"
      w="360px"
      boxShadow="card"
    >
      <Box as="h1" fontSize="22px" mb="8px" color="ink">
        登录到 Quant
      </Box>
      <Box as="p" fontSize="13px" color="ink2" mb="24px">
        使用飞书账号继续。仅用于将你的本地账本、自选股和系统配置与你的身份绑定。
      </Box>
      <a href="/api/auth/feishu/start" style={LOGIN_LINK_STYLE}>
        用飞书登录
      </a>
      {error !== undefined && (
        <Box as="p" mt="16px" fontSize="12px" color="up">
          登录失败：{error}
        </Box>
      )}
    </Box>
  );
}

const LOGIN_LINK_STYLE: React.CSSProperties = {
  display: 'block',
  textAlign: 'center',
  padding: '10px 16px',
  background: 'var(--chakra-colors-link)',
  color: 'var(--chakra-colors-white)',
  borderRadius: '8px',
  textDecoration: 'none',
  fontSize: '14px',
};
