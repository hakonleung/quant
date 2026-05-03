'use client';

import { ChakraProvider } from '@chakra-ui/react';
import type { ReactNode } from 'react';

import { system } from './system.js';

interface ThemeProviderProps {
  readonly children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps): ReactNode {
  return <ChakraProvider value={system}>{children}</ChakraProvider>;
}
