/**
 * Console + file logger.
 *
 * - Console: info/success go to stdout; warn/error to stderr; debug only with --verbose.
 * - File: every level (including debug) is appended with a timestamp, so the log
 *   is useful even when the run was not verbose.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stripAnsi, style } from "../cli/terminalStyle";

type LogLevel = "debug" | "info" | "warn" | "error";

export function defaultLogFilePath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "romkit", "romkit.log");
}

class Logger {
  private verboseEnabled = false;
  private logFilePath: string | null = defaultLogFilePath();
  private logDirectoryReady = false;

  configure(options: { verbose?: boolean; logFilePath?: string }): void {
    if (options.verbose !== undefined) this.verboseEnabled = options.verbose;
    if (options.logFilePath !== undefined) {
      this.logFilePath = options.logFilePath;
      this.logDirectoryReady = false;
    }
  }

  get isVerbose(): boolean {
    return this.verboseEnabled;
  }

  debug(message: string): void {
    if (this.verboseEnabled) console.log(style.dim(message));
    this.writeToFile("debug", message);
  }

  info(message: string): void {
    console.log(message);
    this.writeToFile("info", message);
  }

  success(message: string): void {
    console.log(style.green(message));
    this.writeToFile("info", message);
  }

  warn(message: string): void {
    console.error(style.yellow(message));
    this.writeToFile("warn", message);
  }

  error(message: string): void {
    console.error(style.red(message));
    this.writeToFile("error", message);
  }

  /** Writes only to the log file (e.g. stack traces, the full command line). */
  fileOnly(message: string, level: LogLevel = "debug"): void {
    this.writeToFile(level, message);
  }

  private writeToFile(level: LogLevel, message: string): void {
    if (!this.logFilePath) return;
    try {
      if (!this.logDirectoryReady) {
        mkdirSync(dirname(this.logFilePath), { recursive: true });
        this.logDirectoryReady = true;
      }
      const timestamp = new Date().toISOString();
      const line = `${timestamp} [${level.toUpperCase()}] ${stripAnsi(message)}\n`;
      appendFileSync(this.logFilePath, line, "utf8");
    } catch (error) {
      // A broken log file must never break the actual work: warn once and stop logging to file.
      const failedPath = this.logFilePath;
      this.logFilePath = null;
      console.error(style.yellow(`Could not write log file ${failedPath}: ${(error as Error).message}`));
    }
  }
}

/** Single shared instance; configured by the command router at startup. */
export const logger = new Logger();
