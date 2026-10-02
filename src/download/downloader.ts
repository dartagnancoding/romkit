/**
 * Streams a file to disk with a progress bar.
 *
 * Safety checks:
 * - non-2xx status → blocked (show the page to the user);
 * - an HTML page instead of a file (typical of "click here to continue" or
 *   captcha interstitials) → blocked;
 * - no data for `timeoutMs` → aborted as stalled;
 * - fewer bytes than Content-Length → incomplete download error.
 */

import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { join } from "node:path";
import { ProgressBar } from "../cli/progressBar";
import { RomkitError } from "../errors";
import { logger } from "../logging/logger";
import { sanitizeFileName } from "../naming/filenameSanitizer";
import { blockedOutcome, findChallengeMarker } from "../sources/blockDetector";
import type { HttpClient } from "../sources/httpClient";
import type { BlockedOutcome } from "../sources/sourceAdapter";
import { formatBytes } from "../util/format";

export interface DownloadRequest {
  url: string;
  referer?: string;
  /** Page shown to the user if the download turns out to be blocked. */
  pageUrl: string;
  destinationDirectory: string;
  /** Used when neither the headers nor the URL provide a file name. */
  fallbackFileName: string;
}

export type DownloadOutcome = { kind: "downloaded"; filePath: string; byteCount: number } | BlockedOutcome;

export async function downloadFile(request: DownloadRequest, httpClient: HttpClient): Promise<DownloadOutcome> {
  const { response, abortController } = await httpClient.openDownload(request.url, request.referer);

  if (!response.ok) {
    const status = response.status;
    const isAntiBotStatus = status === 403 || status === 429 || status === 503;
    return blockedOutcome(isAntiBotStatus ? "http-status" : "unexpected-page", `download answered HTTP ${status}`, request.pageUrl);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const html = await response.text();
    const marker = findChallengeMarker(html);
    return marker
      ? blockedOutcome("captcha", `${marker} on the download link`, request.pageUrl)
      : blockedOutcome("unexpected-page", "the download link returned a web page instead of a file", request.pageUrl);
  }

  const fileName = chooseFileName(response, request.fallbackFileName);
  const filePath = join(request.destinationDirectory, fileName);
  const contentLengthHeader = response.headers.get("content-length");
  const expectedBytes = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;

  logger.info(`Downloading ${fileName}${expectedBytes ? ` (${formatBytes(expectedBytes)})` : ""}`);
  const progressBar = new ProgressBar("  ", expectedBytes);
  const output = createWriteStream(filePath);
  let receivedBytes = 0;

  // Idle timer: restarted on every chunk, fires only if the transfer stalls.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const restartIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortController.abort(new Error("stalled")), httpClient.timeoutMs);
  };

  try {
    if (!response.body) throw new RomkitError("The server sent an empty response.");
    restartIdleTimer();
    for await (const chunk of response.body) {
      restartIdleTimer();
      receivedBytes += chunk.byteLength;
      progressBar.advance(chunk.byteLength);
      // Respect backpressure: wait when the disk is slower than the network.
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    await unlink(filePath).catch(() => {});
    if (abortController.signal.aborted) {
      throw new RomkitError(
        `Download stalled: no data received for ${Math.round(httpClient.timeoutMs / 1000)} s.`,
        `Try again, or download manually from ${request.pageUrl} and use \`romkit import\`.`,
      );
    }
    throw error instanceof RomkitError ? error : new RomkitError(`Download failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(idleTimer);
    progressBar.finish();
  }

  if (expectedBytes !== null && receivedBytes < expectedBytes) {
    await unlink(filePath).catch(() => {});
    throw new RomkitError(`Download incomplete: received ${formatBytes(receivedBytes)} of ${formatBytes(expectedBytes)}.`);
  }

  logger.debug(`Saved to ${filePath}`);
  return { kind: "downloaded", filePath, byteCount: receivedBytes };
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

function fileNameFromUrl(url: string): string | null {
  try {
    const lastSegment = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!lastSegment || !lastSegment.includes(".")) return null;
    return decodeURIComponent(lastSegment);
  } catch {
    return null;
  }
}
