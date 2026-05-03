'use client';

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Feat } from '../../lib/eqty/feat.js';
import { Pane } from '../shell/pane.js';

const SlackPushSchema = z
  .object({
    channel: z.string().regex(/^#?[a-z0-9_-]+$/, 'invalid channel'),
    note: z.string().max(280),
  })
  .strict();

type SlackPushForm = z.infer<typeof SlackPushSchema>;

interface Props {
  readonly code: string;
  readonly sentimentScore: number | null;
  readonly theme: string | null;
}

export function SlackPushPanel({ code, sentimentScore, theme }: Props): React.ReactElement {
  const form = useForm<SlackPushForm>({
    resolver: zodResolver(SlackPushSchema),
    defaultValues: { channel: '#quant-signals', note: '' },
  });

  const payload =
    sentimentScore === null
      ? `${code} · sentiment unavailable`
      : `${code} · sent ${sentimentScore.toFixed(2)}${theme === null ? '' : ` · 题材[${theme}]`}`;

  return (
    <Pane feat={Feat.Notif} right={<Text color="term.green">● ready</Text>}>
      <Box
        as="form"
        position="relative"
        px="18px"
        py="14px"
        color="term.ink2"
        fontFamily="mono"
        fontSize="12px"
        lineHeight="1.7"
        flex="1"
        onSubmit={(e) => {
          e.preventDefault();
        }}
        _after={{
          content: '""',
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'repeating-linear-gradient(to bottom, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px)',
        }}
      >
        <PushRow label="CHANNEL">
          <CyberInput {...form.register('channel')} aria-label="channel" />
        </PushRow>
        <PushRow label="PAYLOAD">
          <Text color="term.amber" fontSize="12px">
            {payload}
          </Text>
        </PushRow>
        <PushRow label="NOTE">
          <CyberInput {...form.register('note')} aria-label="note" placeholder="备注…" />
        </PushRow>
        {Object.keys(form.formState.errors).length > 0 && (
          <Text mt="6px" color="term.red" fontSize="11px">
            ✘{' '}
            {Object.values(form.formState.errors)
              .map((e) => e.message)
              .join(' · ')}
          </Text>
        )}
      </Box>
      <Flex
        px="18px"
        py="12px"
        gap="8px"
        borderTopWidth="1px"
        borderColor="term.line"
        bg="term.panel"
      >
        <CyberButton kind="ghost" type="button" onClick={() => form.reset()}>
          CANCEL
        </CyberButton>
        <CyberButton
          kind="primary"
          type="submit"
          ml="auto"
          onClick={form.handleSubmit(() => undefined)}
        >
          ▶ PUSH
        </CyberButton>
      </Flex>
    </Pane>
  );
}

function PushRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Flex gap="10px" py="2px" align="center" position="relative" zIndex={1}>
      <Text color="term.cyan" fontSize="11px" minW="80px">
        ▎ {label}
      </Text>
      <Box flex="1">{children}</Box>
    </Flex>
  );
}

type CyberInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>;
const CyberInput = React.forwardRef<HTMLInputElement, CyberInputProps>(
  function CyberInput(props, ref) {
    return (
      <Input
        ref={ref}
        {...props}
        bg="term.inputBg"
        borderWidth="1px"
        borderColor="term.line2"
        color="term.ink"
        fontFamily="mono"
        fontSize="12px"
        h="28px"
        borderRadius="2px"
        px="10px"
        py="5px"
        _focus={{ borderColor: 'term.green', boxShadow: 'none' }}
      />
    );
  },
);

interface CyberButtonProps {
  readonly kind: 'primary' | 'ghost' | 'danger';
  readonly children: React.ReactNode;
  readonly type?: 'button' | 'submit';
  readonly onClick?: () => void;
  readonly ml?: string;
}

function CyberButton({
  kind,
  children,
  type = 'button',
  onClick,
  ml,
}: CyberButtonProps): React.ReactElement {
  const styles = {
    primary: { bg: 'term.green', color: 'term.bg', borderColor: 'term.green' },
    ghost: { bg: 'transparent', color: 'term.ink2', borderColor: 'term.line2' },
    danger: { bg: 'transparent', color: 'term.red', borderColor: 'term.red' },
  }[kind];

  return (
    <Button
      type={type}
      onClick={onClick}
      ml={ml}
      bg={styles.bg}
      color={styles.color}
      borderWidth="1px"
      borderColor={styles.borderColor}
      borderRadius="0"
      px="12px"
      py="7px"
      h="auto"
      fontFamily="mono"
      fontSize="11px"
      letterSpacing="0.18em"
      textTransform="uppercase"
      _hover={
        kind === 'primary' ? { bg: 'panel' } : { borderColor: 'term.green', color: 'term.green' }
      }
    >
      {children}
    </Button>
  );
}
