/**
 * Single-line progress indicators drawn on stderr.
 * When stderr is not a terminal (output redirected), nothing is redrawn; only
 * the final summary line is printed.
 */

import { formatBytes, formatPercent } from "../util/format";

const isInteractiveTerminal = process.stderr.isTTY === true;
const REDRAW_INTERVAL_MS = 100;
const BAR_WIDTH = 24;

/** Rewrites the current terminal line ("\r" returns to column 0, "\x1b[K" clears the rest). */
function rewriteLine(text: string): void {
  const maxWidth = (process.stderr.columns ?? 100) - 1;
  process.stderr.write(`\r${text.slice(0, maxWidth)}\x1b[K`);
}

export class ProgressBar {
  private transferredBytes: number;
  private lastRedrawTime = 0;
  private readonly startTime = Date.now();

  constructor(
    private readonly label: string,
    /** null when the server did not send Content-Length. */
    private readonly totalBytes: number | null,
    /** Bytes already on disk from an earlier attempt; they count for the bar, not for the speed. */
    private readonly resumedBytes = 0,
  ) {
    this.transferredBytes = resumedBytes;
  }

  advance(byteCount: number): void {
    this.update(this.transferredBytes + byteCount);
  }

  /** Sets the total transferred so far (for tools that report totals, such as aria2c). */
  update(transferredBytes: number): void {
    this.transferredBytes = transferredBytes;
    const now = Date.now();
    if (isInteractiveTerminal && now - this.lastRedrawTime >= REDRAW_INTERVAL_MS) {
      this.lastRedrawTime = now;
      rewriteLine(this.describe());
    }
  }

  finish(): void {
    if (isInteractiveTerminal) {
      rewriteLine(this.describe());
      process.stderr.write("\n");
    } else {
      process.stderr.write(`${this.describe()}\n`);
    }
  }

  private describe(): string {
    const elapsedSeconds = Math.max((Date.now() - this.startTime) / 1000, 0.001);
    const bytesPerSecond = Math.max(this.transferredBytes - this.resumedBytes, 0) / elapsedSeconds;
    const speedText = `${formatBytes(bytesPerSecond)}/s`;

    if (this.totalBytes && this.totalBytes > 0) {
      const ratio = Math.min(this.transferredBytes / this.totalBytes, 1);
      const filledWidth = Math.round(ratio * BAR_WIDTH);
      const bar = "#".repeat(filledWidth) + "-".repeat(BAR_WIDTH - filledWidth);
      const sizeText = `${formatBytes(this.transferredBytes)} / ${formatBytes(this.totalBytes)}`;
      return `${this.label} [${bar}] ${formatPercent(ratio).padStart(4)}  ${sizeText}  ${speedText}`;
    }
    return `${this.label} ${formatBytes(this.transferredBytes)}  ${speedText}`;
  }
}

/** A status line that keeps rewriting itself, e.g. "Identifying 3/120: game.gba". */
export const statusLine = {
  update(text: string): void {
    if (isInteractiveTerminal) rewriteLine(text);
  },
  clear(): void {
    if (isInteractiveTerminal) process.stderr.write("\r\x1b[K");
  },
};
