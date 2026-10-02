/**
 * Minimal ANSI color helpers. Colors are disabled when output is not a terminal
 * (e.g. redirected to a file) or when the NO_COLOR environment variable is set.
 */

const colorsEnabled = process.stdout.isTTY === true && !("NO_COLOR" in process.env);

function wrapWith(openCode: number, closeCode: number) {
  return (text: string): string => (colorsEnabled ? `\x1b[${openCode}m${text}\x1b[${closeCode}m` : text);
}

export const style = {
  bold: wrapWith(1, 22),
  dim: wrapWith(2, 22),
  red: wrapWith(31, 39),
  green: wrapWith(32, 39),
  yellow: wrapWith(33, 39),
  cyan: wrapWith(36, 39),
};

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

/** Removes color codes, used for the log file and for measuring visible text width. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}
