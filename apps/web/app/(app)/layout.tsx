import type { ReactNode } from 'react';

import { Box } from '@chakra-ui/react';

import { Footer } from '../../components/shell/footer.js';
import { TopBar } from '../../components/shell/top-bar.js';

interface AppLayoutProps {
  readonly children: ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps): ReactNode {
  return (
    <Box as="main" h="100vh" bg="bg" display="flex" flexDirection="column" overflow="hidden">
      <TopBar />
      <Box flex="1" minH={0}>
        {children}
      </Box>
      <Footer />
    </Box>
  );
}
