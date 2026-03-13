/**
 * src/cli/colors.ts — ANSI color helpers for CLI output
 *
 * Only colorizes when stderr is a TTY. Stdout is never colored
 * (it carries structured data for agents).
 */

const enabled = !!(process.stderr.isTTY || process.env.FORCE_COLOR);

function wrap(code: string, reset: string) {
  return (s: string) => enabled ? `${code}${s}${reset}` : s;
}

const RST = '\x1b[0m';

export const c = {
  bold:    wrap('\x1b[1m', RST),
  dim:     wrap('\x1b[2m', RST),
  red:     wrap('\x1b[31m', RST),
  green:   wrap('\x1b[32m', RST),
  yellow:  wrap('\x1b[33m', RST),
  blue:    wrap('\x1b[34m', RST),
  magenta: wrap('\x1b[35m', RST),
  cyan:    wrap('\x1b[36m', RST),

  // Combos
  boldRed:    wrap('\x1b[1;31m', RST),
  boldGreen:  wrap('\x1b[1;32m', RST),
  boldYellow: wrap('\x1b[1;33m', RST),
  boldBlue:   wrap('\x1b[1;34m', RST),
  boldCyan:   wrap('\x1b[1;36m', RST),
};
