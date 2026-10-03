/**
 * Optional aria2c backend: several connections per file and resumable
 * downloads, for when aria2c is installed (`winget install aria2.aria2`).
 *
 * romkit still makes the first request itself (to catch HTML/captcha pages and
 * learn the file name and size); aria2c only transfers the bytes.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DownloadSettings } from "../config/configTypes";
import { RomkitError } from "../errors";
import { ProgressBar } from "../cli/progressBar";
import { logger } from "../logging/logger";

export type Downloader = { kind: "builtin" } | { kind: "aria2c"; executablePath: string; connections: number };

export const BUILTIN_DOWNLOADER: Downloader = { kind: "builtin" };

const ARIA2C_INSTALL_HINT = "Install it with `winget install aria2.aria2`, or set \"download.tool\" to \"builtin\" in the config.";

/** Picks the download backend from the config: aria2c when wanted and found, the built-in one otherwise. */
export function resolveDownloader(settings: DownloadSettings): Downloader {
  if (settings.tool === "builtin") return BUILTIN_DOWNLOADER;

  const executablePath = settings.aria2cPath ?? findAria2c();
  if (executablePath && existsSync(executablePath)) {
    logger.debug(`Downloading with aria2c (${settings.connections} connections): ${executablePath}`);
    return { kind: "aria2c", executablePath, connections: settings.connections };
  }
  if (settings.tool === "aria2c") {
    throw new RomkitError(
      settings.aria2cPath ? `aria2c not found at ${settings.aria2cPath}.` : "aria2c was not found.",
      ARIA2C_INSTALL_HINT,
    );
  }
  logger.debug("aria2c not found; using the built-in downloader.");
  return BUILTIN_DOWNLOADER;
}

/** PATH first, then winget's folders (a fresh winget install is not on PATH until the terminal restarts). */
export function findAria2c(): string | null {
  const onPath = Bun.which("aria2c");
  if (onPath) return onPath;

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const wingetLink = join(localAppData, "Microsoft", "WinGet", "Links", "aria2c.exe");
  if (existsSync(wingetLink)) return wingetLink;

  // winget unpacks portable apps to Packages\aria2.aria2_<source>\aria2-<version>-win-64bit-build1\aria2c.exe
  const packagesDirectory = join(localAppData, "Microsoft", "WinGet", "Packages");
  try {
    for (const packageFolder of readdirSync(packagesDirectory).filter((name) => name.toLowerCase().startsWith("aria2.aria2"))) {
      const packagePath = join(packagesDirectory, packageFolder);
      for (const versionFolder of readdirSync(packagePath)) {
        const candidate = join(packagePath, versionFolder, "aria2c.exe");
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // No winget packages folder: nothing to find.
  }
  return null;
}

export interface Aria2cJob {
  url: string;
  referer?: string;
  userAgent: string;
  timeoutMs: number;
  directory: string;
  fileName: string;
  expectedBytes: number | null;
  /** Bytes already on disk from an earlier attempt, for the progress bar. */
  resumedBytes: number;
}

/** Runs aria2c until the file is complete. aria2c keeps a ".aria2" control file, so a rerun continues. */
export async function runAria2c(downloader: Extract<Downloader, { kind: "aria2c" }>, job: Aria2cJob): Promise<void> {
  const connections = String(downloader.connections);
  const command = [
    downloader.executablePath,
    `--max-connection-per-server=${connections}`,
    `--split=${connections}`,
    "--min-split-size=1M",
    "--continue=true",
    "--file-allocation=none",
    "--auto-file-renaming=false",
    "--allow-overwrite=true",
    "--max-tries=5",
    "--retry-wait=3",
    `--timeout=${Math.max(Math.round(job.timeoutMs / 1000), 5)}`,
    "--summary-interval=1",
    "--show-console-readout=false",
    "--console-log-level=error",
    "--download-result=hide",
    `--user-agent=${job.userAgent}`,
    ...(job.referer ? [`--referer=${job.referer}`] : []),
    `--dir=${job.directory}`,
    `--out=${job.fileName}`,
    job.url,
  ];
  logger.debug(command.join(" "));

  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const progressBar = new ProgressBar("  ", job.expectedBytes, job.resumedBytes);
  const outputLines: string[] = [];
  try {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      for (const line of decoder.decode(chunk, { stream: true }).split(/[\r\n]+/)) {
        const transferred = parseTransferredBytes(line);
        if (transferred !== null) progressBar.update(transferred);
        else if (line.trim() !== "" && !line.startsWith(" ***") && !/^[=-]+$/.test(line.trim()) && !line.startsWith("FILE:")) {
          outputLines.push(line.trim());
        }
      }
    }
    const exitCode = await child.exited;
    const errorText = (await new Response(child.stderr).text()).trim();
    if (exitCode !== 0) {
      const detail = [errorText, ...outputLines].filter(Boolean).slice(-3).join(" | ");
      throw new RomkitError(`aria2c stopped with code ${exitCode}${detail ? `: ${detail}` : ""}.`);
    }
    // aria2c's last summary can predate the end of the transfer.
    if (job.expectedBytes !== null) progressBar.update(job.expectedBytes);
  } finally {
    progressBar.finish();
  }
}

const UNIT_BYTES: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };

/** "[#91b596 22MiB/93MiB(23%) CN:4 DL:7.8MiB ETA:9s]" → 23068672 */
export function parseTransferredBytes(line: string): number | null {
  const match = /\[#\w+ ([\d.]+)(B|KiB|MiB|GiB|TiB)\//.exec(line);
  if (!match) return null;
  return Math.round(Number(match[1]) * UNIT_BYTES[match[2]!]!);
}
