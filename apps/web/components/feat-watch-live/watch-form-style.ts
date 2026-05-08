/**
 * Shared Chakra `Input` styling for every form field in the WATCH
 * add-form. Lifted out so the row sub-components can import it
 * without depending on the orchestrator file.
 */

export const INPUT_STYLE = {
  bg: 'term.bg' as const,
  borderColor: 'term.line' as const,
  color: 'term.ink' as const,
  fontFamily: 'mono' as const,
  fontSize: '12px',
  h: '24px',
  px: '6px',
};
