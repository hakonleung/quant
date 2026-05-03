'use client';

import { Box, Flex, HStack, Input, Text } from '@chakra-ui/react';
import { useState, type KeyboardEvent } from 'react';

import { useNlScreen } from '../../lib/hooks/use-nl-screen.js';
import { useUiStore, type ModuleId } from '../../lib/stores/ui.store.js';

interface MenuItem {
  readonly label: string;
  readonly view: ModuleId;
}

const MENU: readonly MenuItem[] = [
  { label: 'EQTY', view: 'eqty' },
  { label: 'STKS', view: 'stocks' },
];

export function TopBar(): React.ReactElement {
  return (
    <Flex h="42px" bg="panel" borderBottomWidth="2px" borderBottomColor="accent" align="center">
      <Brand />
      <Menu />
      <Box flex="1" />
      <CommandBar />
    </Flex>
  );
}

function Brand(): React.ReactElement {
  return (
    <HStack
      bg="accent"
      color="panel"
      h="100%"
      px="14px"
      gap="10px"
      letterSpacing="0.18em"
      fontWeight="700"
      fontSize="12px"
    >
      <Box
        position="relative"
        w="28px"
        h="28px"
        borderWidth="1.5px"
        borderColor="panel"
        display="grid"
        placeItems="center"
        fontFamily="mono"
        fontSize="14px"
        fontWeight="700"
      >
        Q
        <Box
          position="absolute"
          top="-3px"
          left="-3px"
          w="5px"
          h="5px"
          borderTopWidth="1.5px"
          borderLeftWidth="1.5px"
          borderColor="panel"
        />
        <Box
          position="absolute"
          bottom="-3px"
          right="-3px"
          w="5px"
          h="5px"
          borderBottomWidth="1.5px"
          borderRightWidth="1.5px"
          borderColor="panel"
        />
      </Box>
      <Box lineHeight="1.1">
        <Text>QUANT//OS</Text>
        <Text fontSize="9px" letterSpacing="0.22em" opacity={0.85} fontWeight="500">
          v0.1 · LOCAL
        </Text>
      </Box>
    </HStack>
  );
}

function Menu(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  return (
    <HStack as="nav" gap={0} h="100%">
      {MENU.map((item) => {
        const active = item.view === view;
        return (
          <Flex
            key={item.label}
            align="center"
            px="14px"
            h="100%"
            color={active ? 'accent' : 'ink2'}
            bg={active ? 'accentBg' : 'transparent'}
            fontWeight={active ? '700' : '500'}
            borderRightWidth="1px"
            borderRightColor="line"
            fontFamily="mono"
            fontSize="11px"
            letterSpacing="0.14em"
            textTransform="uppercase"
            cursor="pointer"
            onClick={(): void => {
              setView(item.view);
            }}
            _hover={active ? {} : { color: 'ink', bg: 'hover' }}
          >
            {item.label}
          </Flex>
        );
      })}
    </HStack>
  );
}

/**
 * Command bar — accepts a natural-language screen query (or a 6-digit
 * code for direct lookup). On `Enter` it fires `useNlScreen`; the
 * mutation result lands in the UI store and the BlotterPanel renders
 * the parsed AST + matches side by side.
 */
function CommandBar(): React.ReactElement {
  const [text, setText] = useState('');
  const setNlResult = useUiStore((s) => s.setNlResult);
  const setFocusCode = useUiStore((s) => s.setFocusCode);
  const screen = useNlScreen();

  const onSubmit = (): void => {
    const nl = text.trim();
    if (nl.length === 0 || screen.isPending) return;
    if (/^\d{6}$/.test(nl)) {
      // bare code → focus it; no need to LLM-translate
      setFocusCode(nl);
      return;
    }
    screen.mutate(
      { nl },
      {
        onSuccess: (data) => {
          setNlResult(data);
        },
      },
    );
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
    }
  };

  const status = screen.isPending
    ? '…RUN'
    : screen.isError
      ? '✘ ERR'
      : '↵ EXEC';
  const statusColor = screen.isError ? 'term.red' : 'term.ink3';

  return (
    <Flex
      h="100%"
      px="14px"
      align="center"
      gap="10px"
      borderLeftWidth="1px"
      borderLeftColor="line"
      bg="term.bg"
      position="relative"
      _before={{
        content: '""',
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background:
          'repeating-linear-gradient(to bottom, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px)',
      }}
    >
      <Flex
        align="center"
        gap="8px"
        bg="term.inputBg"
        borderWidth="1px"
        borderColor="term.line2"
        px="12px"
        h="28px"
        w="380px"
        position="relative"
        zIndex={1}
        _before={{
          content: '">"',
          color: 'term.green',
          fontFamily: 'mono',
          fontSize: '12px',
          fontWeight: '600',
        }}
      >
        <Input
          variant="outline"
          border="0"
          h="auto"
          minH="auto"
          p={0}
          bg="transparent"
          color="term.ink"
          fontFamily="mono"
          fontSize="13px"
          letterSpacing="0.04em"
          placeholder="<code> 或 自然语言筛选语句"
          value={text}
          onChange={(e): void => {
            setText(e.target.value);
          }}
          onKeyDown={onKey}
          _focus={{ boxShadow: 'none' }}
        />
        <Text className="blink" color="term.green" fontWeight="700" fontFamily="mono">
          ▌
        </Text>
        <Text color={statusColor} fontFamily="mono" fontSize="10px" letterSpacing="0.18em">
          {status}
        </Text>
      </Flex>
    </Flex>
  );
}
