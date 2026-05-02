import type { ReactNode } from 'react';

interface RootLayoutProps {
  readonly children: ReactNode;
}

export const metadata = {
  title: 'Quant',
  description: 'Stock screening workbench',
};

export default function RootLayout({ children }: RootLayoutProps): ReactNode {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
