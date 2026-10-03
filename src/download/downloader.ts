/**
 * Downloads a file into the job folder, continuing earlier attempts.
 *
 * The first request is always romkit's own, so the safety checks apply whatever
 * transfers the bytes:
 * - non-2xx status → blocked (show the page to the user);
 * - an HTML page instead of a file (typical of "click here to continue" or
 *   captcha interstitials) → blocked.
 *
 * The bytes go to <partialRoot>\<hash of the URL>\ until the file is complete,
 * so an interrupted download (lost connection, Ctrl+C) continues where it stopped
 * the next time the same file is downloaded. Then it moves to the job folder.
 * Transfer: aria2c when available (several connections), else the built-in
 * streamer, which retries a dropped connection with an HTTP Range request.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { join } from "node:path";
import { ProgressBar } from "../cli/progressBar";
import { RomkitError } from "../errors";
import { logger } from "../logging/logger";
import { sanitizeFileName } from "../naming/filenameSanitizer";
import { blockedOutcome, findChallengeMarker } from "../sources/blockDetector";
import type { HttpClient, OpenedDownload } from "../sources/httpClient";
import type { BlockedOutcome } from "../sources/sourceAdapter";
import { formatBytes } from "../util/format";
import { BUILTIN_DOWNLOADER, type Downloader, runAria2c } from "./aria2c";

export interface DownloadRequest {
  url: string;
  referer?: string;
  /** Page shown to the user if the download turns out to be blocked. */
  pageUrl: string;
  destinationDirectory: string;
  /** Used when neither the headers nor the URL provide a file name. */
  fallbackFileName: string;
  /** Unfinished downloads wait here between attempts. */
  partialRoot: string;
}

export type DownloadOutcome = { kind: "downloaded"; filePath: string; byteCount: number } | BlockedOutcome;

/** Built-in downloader: attempts per run before giving up (the next run still continues). */
const MAX_ATTEMPTS = 3;

/** What identifies "the same file" between runs; a mismatch discards the partial copy. */
interface PartialIdentity {
  url: string;
  fileName: string;
  expectedBytes: number | null;
  /** ETag or Last-Modified: changes when the file on the server changes. */
  version: string | null;
}

export async function downloadFile(
  request: DownloadRequest,
  httpClient: HttpClient,
  downloader: Downloader = BUILTIN_DOWNLOADER,
): Promise<DownloadOutcome> {
  const probe = await httpClient.openDownload(request.url, request.referer);
  const rejection = await rejectNonFile(probe.response, request.pageUrl);
  if (rejection) return rejection;

  const fileName = chooseFileName(probe.response, request.fallbackFileName);
  const expectedBytes = parseContentLength(probe.response);
  const identity: PartialIdentity = {
    url: request.url,
    fileName,
    expectedBytes,
    version: probe.response.headers.get("etag") ?? probe.response.headers.get("last-modified"),
  };
  const partialDirectory = join(request.partialRoot, createHash("sha1").update(request.url).digest("hex").slice(0, 16));
  const partialPath = join(partialDirectory, fileName);
  const resumedBytes = await preparePartial(partialDirectory, partialPath, identity);

  const sizeText = expectedBytes ? ` (${formatBytes(expectedBytes)})` : "";
  const resumeText = resumedBytes > 0 ? `, continuing from ${formatBytes(resumedBytes)}` : "";
  logger.info(`Downloading ${fileName}${sizeText}${resumeText}`);

  try {
    if (downloader.kind === "aria2c") {
      probe.abortController.abort();
      await runAria2c(downloader, {
        url: request.url,
        referer: request.referer,
        userAgent: httpClient.userAgent,
        timeoutMs: httpClient.timeoutMs,
        directory: partialDirectory,
        fileName,
        expectedBytes,
        resumedBytes,
      });
    } else {
      await streamWithRetries(probe, request, httpClient, partialPath, expectedBytes, resumedBytes);
    }
  } catch (error) {
    const savedBytes = await sizeOf(partialPath);
    const message = error instanceof RomkitError ? error.message : `Download failed: ${(error as Error).message}`;
    throw new RomkitError(
      message,
      savedBytes > 0
        ? `${formatBytes(savedBytes)} were kept: run the same command again to continue, or download manually from ${request.pageUrl}.`
        : `Try again, or download manually from ${request.pageUrl} and use \`romkit import\`.`,
    );
  }

  const byteCount = await sizeOf(partialPath);
  if (expectedBytes !== null && byteCount < expectedBytes) {
    throw new RomkitError(
      `Download incomplete: received ${formatBytes(byteCount)} of ${formatBytes(expectedBytes)}.`,
      "Run the same command again to continue.",
    );
  }

  const filePath = join(request.destinationDirectory, fileName);
  await moveFile(partialPath, filePath);
  await rm(partialDirectory, { recursive: true, force: true });
  logger.debug(`Saved to ${filePath}`);
  return { kind: "downloaded", filePath, byteCount };
}

async function rejectNonFile(response: Response, pageUrl: string): Promise<BlockedOutcome | null> {
  if (!response.ok) {
    const status = response.status;
    const isAntiBotStatus = status === 403 || status === 429 || status === 503;
    return blockedOutcome(isAntiBotStatus ? "http-status" : "unexpected-page", `download answered HTTP ${status}`, pageUrl);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return null;
  const html = await response.text();
  const marker = findChallengeMarker(html);
  return marker
    ? blockedOutcome("captcha", `${marker} on the download link`, pageUrl)
    : blockedOutcome("unexpected-page", "the download link returned a web page instead of a file", pageUrl);
}

/**
 * Keeps the partial copy when it belongs to the same file on the server,
 * discards it otherwise. Returns the bytes kept.
 */
async function preparePartial(partialDirectory: string, partialPath: string, identity: PartialIdentity): Promise<number> {
  const identityPath = join(partialDirectory, "romkit-partial.json");
  let previousIdentity: PartialIdentity | null = null;
  try {
    previousIdentity = JSON.parse(await readFile(identityPath, "utf8")) as PartialIdentity;
  } catch {
    // No earlier attempt.
  }
  const sameFile =
    previousIdentity !== null &&
    previousIdentity.fileName === identity.fileName &&
    previousIdentity.expectedBytes === identity.expectedBytes &&
    previousIdentity.version === identity.version;
  if (!sameFile) await rm(partialDirectory, { recursive: true, force: true });

  await mkdir(partialDirectory, { recursive: true });
  await writeFile(identityPath, JSON.stringify(identity), "utf8");
  return sameFile ? sizeOf(partialPath) : 0;
}

/** Built-in transfer: streams to disk; a dropped or stalled connection is retried from the last byte saved. */
async function streamWithRetries(
  probe: OpenedDownload,
  request: DownloadRequest,
  httpClient: HttpClient,
  partialPath: string,
  expectedBytes: number | null,
  resumedBytes: number,
): Promise<void> {
  const progressBar = new ProgressBar("  ", expectedBytes, resumedBytes);
  let pendingProbe: OpenedDownload | null = probe;
  try {
    for (let attempt = 1; ; attempt++) {
      const savedBytes = await sizeOf(partialPath);
      if (expectedBytes !== null && savedBytes >= expectedBytes) {
        pendingProbe?.abortController.abort();
        return;
      }

      // The probe starts at byte 0, so it can only be reused for a fresh file.
      let opened = pendingProbe;
      pendingProbe = null;
      if (!opened || savedBytes > 0) {
        opened?.abortController.abort();
        opened = await httpClient.openDownload(request.url, request.referer, savedBytes > 0 ? { Range: `bytes=${savedBytes}-` } : {});
      }
      if (!opened.response.ok) throw new RomkitError(`The download answered HTTP ${opened.response.status}.`);
      // 206 = the server sent only the missing part; 200 = it ignored the range and sent everything.
      const append = savedBytes > 0 && opened.response.status === 206;
      progressBar.update(append ? savedBytes : 0);

      try {
        await streamToFile(opened, partialPath, append, progressBar, httpClient.timeoutMs);
        const finalBytes = await sizeOf(partialPath);
        if (expectedBytes === null || finalBytes >= expectedBytes) return;
        throw new Error(`connection closed at ${formatBytes(finalBytes)}`);
      } catch (error) {
        const stalled = opened.abortController.signal.aborted;
        if (attempt >= MAX_ATTEMPTS) {
          throw stalled ? new RomkitError(`Download stalled: no data received for ${Math.round(httpClient.timeoutMs / 1000)} s.`) : error;
        }
        logger.debug(`Attempt ${attempt} failed: ${(error as Error).message}`);
        const savedText = formatBytes(await sizeOf(partialPath));
        logger.warn(`${stalled ? "Download stalled" : "Connection lost"} at ${savedText}; trying again (${attempt + 1}/${MAX_ATTEMPTS})...`);
      }
    }
  } finally {
    progressBar.finish();
  }
}

async function streamToFile(
  opened: OpenedDownload,
  filePath: string,
  append: boolean,
  progressBar: ProgressBar,
  idleTimeoutMs: number,
): Promise<void> {
  const { response, abortController } = opened;
  if (!response.body) throw new RomkitError("The server sent an empty response.");
  const output = createWriteStream(filePath, { flags: append ? "a" : "w" });

  // Idle timer: restarted on every chunk, fires only if the transfer stalls.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const restartIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortController.abort(new Error("stalled")), idleTimeoutMs);
  };

  try {
    restartIdleTimer();
    for await (const chunk of response.body) {
      restartIdleTimer();
      progressBar.advance(chunk.byteLength);
      // Respect backpressure: wait when the disk is slower than the network.
      if (!output.write(chunk)) await once(output, "drain");
    }
  } finally {
    clearTimeout(idleTimer);
    // Whatever was written stays on disk: the next attempt continues from it.
    output.end();
    await finished(output).catch(() => {});
  }
}

function parseContentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  const value = header ? Number.parseInt(header, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function sizeOf(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

/** rename, or copy + delete when the folders are on different drives. */
async function moveFile(fromPath: string, toPath: string): Promise<void> {
  try {
    await rename(fromPath, toPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(fromPath, toPath);
    await unlink(fromPath);
  }
}

/** Prefers Content-Disposition, then the last URL segment, then the fallback. */
function chooseFileName(response: Response, fallbackFileName: string): string {
  const headerName = fileNameFromContentDisposition(response.headers.get("content-disposition"));
  const urlName = fileNameFromUrl(response.url);
  const chosenName = headerName ?? urlName ?? fallbackFileName;
  return sanitizeFileName(chosenName);
}

export function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // RFC 5987 form: filename*=UTF-8''Mega%20Man.zip (takes precedence when present).
  const extendedMatch = /filename\*\s*=\s*(?:[\w-]+)?''([^;]+)/i.exec(header);
  if (extendedMatch?.[1]) {
    try {
      return decodeURIComponent(extendedMatch[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Malformed percent-encoding: fall through to the plain form.
    }
  }
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(header);
  const plainName = plainMatch?.[1] ?? plainMatch?.[2];
  return plainName ? plainName.trim() : null;
}

export function fileNameFromUrl(url: string): string | null {
  try {
    const lastSegment = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!lastSegment || !lastSegment.includes(".")) return null;
    // "ROMS.zip/USA%2FGame.nes" is a path inside an archive: keep only "Game.nes".
    return decodeURIComponent(lastSegment).split(/[\\/]/).pop() || null;
  } catch {
    return null;
  }
}
