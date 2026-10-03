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

/** What a ProgressBar reports to a listener instead of drawing itself. */
export interface ProgressSnapshot {
  transferredBytes: number;
  /** null when the size is unknown. */
  totalBytes: number | null;
  bytesPerSecond: number;
  done: boolean;
}

export type ProgressListener = (snapshot: ProgressSnapshot) => void;

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
    /** When given, nothing is drawn: the listener receives every update (several downloads share one line). */
    private readonly listener?: ProgressListener,
  ) {
    this.transferredBytes = resumedBytes;
  }

  advance(byteCount: number): void {
    this.update(this.transferredBytes + byteCount);
  }

  /** Sets the total transferred so far (for tools that report totals, such as aria2c). */
  update(transferredBytes: number): void {
    this.transferredBytes = transferredBytes;
    if (this.listener) {
      this.listener(this.snapshot(false));
      return;
    }
    const now = Date.now();
    if (isInteractiveTerminal && now - this.lastRedrawTime >= REDRAW_INTERVAL_MS) {
      this.lastRedrawTime = now;
      rewriteLine(this.describe());
    }
  }

  finish(): void {
    if (this.listener) {
      this.listener(this.snapshot(true));
      return;
    }
    if (isInteractiveTerminal) {
      rewriteLine(this.describe());
      process.stderr.write("\n");
    } else {
      process.stderr.write(`${this.describe()}\n`);
    }
  }

  private bytesPerSecond(): number {
    const elapsedSeconds = Math.max((Date.now() - this.startTime) / 1000, 0.001);
    return Math.max(this.transferredBytes - this.resumedBytes, 0) / elapsedSeconds;
  }

  private snapshot(done: boolean): ProgressSnapshot {
    return { transferredBytes: this.transferredBytes, totalBytes: this.totalBytes, bytesPerSecond: this.bytesPerSecond(), done };
  }

  private describe(): string {
    const bytesPerSecond = this.bytesPerSecond();
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

let statusLineVisible = false;

/** A status line that keeps rewriting itself, e.g. "Identifying 3/120: game.gba". */
export const statusLine = {
  update(text: string): void {
    if (!isInteractiveTerminal) return;
    rewriteLine(text);
    statusLineVisible = true;
  },
  clear(): void {
    if (isInteractiveTerminal) process.stderr.write("\r\x1b[K");
    statusLineVisible = false;
  },
  /** Called by the logger before printing, so a message never lands on the status line; the next update redraws it. */
  makeRoomForMessage(): void {
    if (statusLineVisible) this.clear();
  },
};
