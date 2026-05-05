'use client';

/**
 * SYS.PUSH — fire a one-shot Slack message that bundles the focused
 * stock's sentiment readout. The form posts to the BFF
 * (`/api/push/test`) which delegates to the same Slack-webhook adapter
 * the watch scheduler uses; when no webhook is configured the server
 * returns `{dryRun: true}` and we surface that distinctly so the user
 * knows the message was logged but not delivered.
 */

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  PushTestResponseSchema,
  type PushTestRequest,
  type PushTestResponse,
} from '@quant/shared';
import { useMutation } from '@tanstack/react-query';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { apiPost } from '../../lib/api/client.js';
import { Feat } from '../../lib/eqty/feat.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatViewStatus } from '../feat-view/feat-view-header.js';

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

export function FeatSysPush({ code, sentimentScore, theme }: Props): React.ReactElement {
  const form = useForm<SlackPushForm>({
    resolver: zodResolver(SlackPushSchema),
    defaultValues: { channel: '#quant-signals', note: '' },
  });

  const payload = buildPayload(code, sentimentScore, theme);

  const mutation = useMutation<PushTestResponse, Error, PushTestRequest>({
    mutationFn: (body) =>
      apiPost('/api/push/test', body, (raw) => PushTestResponseSchema.parse(raw)),
  });

  const tone: 'green' | 'amber' | 'red' = mutation.isError
    ? 'red'
    : mutation.isPending
      ? 'amber'
      : mutation.data?.dryRun === true
        ? 'amber'
        : 'green';

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate({
      channel: values.channel,
      payload,
      ...(values.note.trim().length > 0 ? { note: values.note.trim() } : {}),
    });
  });

  return (
    <FeatView feat={Feat.SysPush} right={<FeatViewStatus tone={tone} blink={mutation.isPending} />}>
      <Box
        as="form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
        position="relative"
        flex="1"
        display="flex"
        flexDirection="column"
        color="term.ink2"
        fontFamily="mono"
        fontSize="12px"
      >
        <Box
          px="16px"
          py="12px"
          borderBottomWidth="1px"
          borderColor="term.line"
          position="relative"
          _after={{
            content: '""',
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'repeating-linear-gradient(to bottom, rgba(255,255,255,0.018) 0 1px, transparent 1px 3px)',
          }}
        >
          <PreviewCard payload={payload} sentimentScore={sentimentScore} theme={theme} />
        </Box>

        <Box px="16px" py="10px" flex="1">
          <FieldRow label="CHANNEL">
            <CyberInput {...form.register('channel')} aria-label="channel" />
          </FieldRow>
          <FieldRow label="NOTE">
            <CyberInput
              {...form.register('note')}
              aria-label="note"
              placeholder="optional one-liner…"
            />
          </FieldRow>
          <StatusLine
            isPending={mutation.isPending}
            error={
              Object.values(form.formState.errors)
                .map((e) => e.message)
                .join(' · ') ||
              (mutation.error?.message ?? null)
            }
            result={mutation.data ?? null}
          />
        </Box>

        <Flex
          px="16px"
          py="10px"
          gap="8px"
          borderTopWidth="1px"
          borderColor="term.line"
          bg="term.panel"
          align="center"
        >
          <Text color="term.ink3" fontSize="10px" letterSpacing="0.16em">
            ▎ TARGET · slack
          </Text>
          <CyberButton
            kind="ghost"
            type="button"
            ml="auto"
            onClick={(): void => {
              form.reset();
              mutation.reset();
            }}
          >
            RESET
          </CyberButton>
          <CyberButton kind="primary" type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? '… SENDING' : '▶ PUSH'}
          </CyberButton>
        </Flex>
      </Box>
    </FeatView>
  );
}

function buildPayload(code: string, score: number | null, theme: string | null): string {
  if (score === null) return `${code} · sentiment unavailable`;
  const themeStr = theme === null ? '' : ` · 题材[${theme}]`;
  return `${code} · sent ${score.toFixed(2)}${themeStr}`;
}

interface PreviewProps {
  readonly payload: string;
  readonly sentimentScore: number | null;
  readonly theme: string | null;
}

function PreviewCard({ payload, sentimentScore, theme }: PreviewProps): React.ReactElement {
  const tone =
    sentimentScore === null
      ? 'term.ink3'
      : sentimentScore >= 0.3
        ? 'term.green'
        : sentimentScore <= -0.3
          ? 'term.red'
          : 'term.amber';
  const scoreText = sentimentScore === null ? '—' : sentimentScore.toFixed(2);
  return (
    <Box position="relative" zIndex={1}>
      <Flex align="center" gap="8px" mb="6px">
        <Text color="term.cyan" fontSize="10px" letterSpacing="0.18em" fontWeight="700">
          ▎ PAYLOAD
        </Text>
        <Box flex="1" h="1px" bg="term.line2" />
        <Text color={tone} fontSize="11px" fontWeight="700">
          sent {scoreText}
        </Text>
      </Flex>
      <Box
        bg="term.bg"
        borderWidth="1px"
        borderColor="term.line2"
        borderLeftWidth="2px"
        borderLeftColor={tone}
        px="10px"
        py="8px"
        borderRadius="2px"
      >
        <Text color="term.ink" fontSize="12px" lineHeight="1.5" wordBreak="break-word">
          {payload}
        </Text>
        {theme !== null && theme !== '' && (
          <Flex mt="4px" gap="6px" wrap="wrap">
            {theme
              .split(/[、,，]\s*/)
              .filter((t) => t.length > 0)
              .map((t) => (
                <Text
                  key={t}
                  px="6px"
                  py="1px"
                  borderWidth="1px"
                  borderColor="term.line2"
                  color="term.amber"
                  fontSize="10px"
                  letterSpacing="0.06em"
                >
                  {t}
                </Text>
              ))}
          </Flex>
        )}
      </Box>
    </Box>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Flex gap="10px" py="3px" align="center" position="relative" zIndex={1}>
      <Text color="term.cyan" fontSize="10px" letterSpacing="0.18em" minW="80px" fontWeight="700">
        ▎ {label}
      </Text>
      <Box flex="1">{children}</Box>
    </Flex>
  );
}

interface StatusLineProps {
  readonly isPending: boolean;
  readonly error: string | null;
  readonly result: PushTestResponse | null;
}

function StatusLine({ isPending, error, result }: StatusLineProps): React.ReactElement | null {
  if (isPending) {
    return (
      <Text mt="8px" color="term.amber" fontSize="11px" letterSpacing="0.1em">
        ░ transmitting…
      </Text>
    );
  }
  if (error !== null && error !== '') {
    return (
      <Text mt="8px" color="term.red" fontSize="11px" letterSpacing="0.04em">
        ✘ {error}
      </Text>
    );
  }
  if (result !== null) {
    const tag = result.dryRun ? 'DRY-LOG' : 'DELIVERED';
    const color = result.dryRun ? 'term.amber' : 'term.green';
    return (
      <Text mt="8px" color={color} fontSize="11px" letterSpacing="0.06em">
        ✓ {tag} · {result.deliveredAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}
      </Text>
    );
  }
  return null;
}

type CyberInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>;
const CyberInput = React.forwardRef<HTMLInputElement, CyberInputProps>(function CyberInput(
  props,
  ref,
) {
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
});

interface CyberButtonProps {
  readonly kind: 'primary' | 'ghost' | 'danger';
  readonly children: React.ReactNode;
  readonly type?: 'button' | 'submit';
  readonly onClick?: () => void;
  readonly ml?: string;
  readonly disabled?: boolean;
}

function CyberButton({
  kind,
  children,
  type = 'button',
  onClick,
  ml,
  disabled,
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
      disabled={disabled === true}
      bg={styles.bg}
      color={styles.color}
      borderWidth="1px"
      borderColor={styles.borderColor}
      borderRadius="0"
      px="14px"
      py="7px"
      h="auto"
      fontFamily="mono"
      fontSize="11px"
      letterSpacing="0.18em"
      textTransform="uppercase"
      fontWeight="700"
      transition="all 120ms ease"
      _hover={
        kind === 'primary'
          ? { bg: 'term.bg', color: 'term.green' }
          : { borderColor: 'term.green', color: 'term.green' }
      }
      _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
    >
      {children}
    </Button>
  );
}
