/**
 * Polite HTTP client used by every source and by the downloader:
 * - sends the configured User-Agent;
 * - enforces a timeout;
 * - waits `delayBetweenRequestsMs` between requests to the same host.
 */

import type { HttpSettings } from "../config/configTypes";
import { RomkitError } from "../errors";
import { logger } from "../logging/logger";

export interface FetchedPage {
  requestedUrl: string;
  /** URL after redirects; relative links on the page are resolved against it. */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

export interface OpenedDownload {
  response: Response;
  /** Lets the downloader abort a stalled transfer. */
  abortController: AbortController;
}

export class HttpClient {
  private readonly lastRequestTimeByHost = new Map<string, number>();

  constructor(private readonly settings: HttpSettings) {}

  get timeoutMs(): number {
    return this.settings.timeoutMs;
  }

  async fetchPage(url: string, referer?: string): Promise<FetchedPage> {
    await this.waitForTurn(url);
    logger.debug(`GET ${url}`);
    try {
      const response = await fetch(url, {
        headers: this.buildHeaders(referer, "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"),
        redirect: "follow",
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      const body = await response.text();
      logger.debug(`  → HTTP ${response.status}, ${body.length} chars`);
      return {
        requestedUrl: url,
        finalUrl: response.url || url,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body,
      };
    } catch (error) {
      throw this.describeNetworkError(url, error);
    }
  }

  /**
   * Starts a download and returns as soon as the response headers arrive.
   * The timeout here only covers waiting for the headers; the downloader handles
   * stalls during the transfer itself (a big file can legitimately take minutes).
   */
  async openDownload(url: string, referer?: string): Promise<OpenedDownload> {
    await this.waitForTurn(url);
    logger.debug(`GET (download) ${url}`);
    const abortController = new AbortController();
    const headerTimer = setTimeout(() => abortController.abort(new Error("timeout")), this.settings.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: this.buildHeaders(referer, "*/*"),
        redirect: "follow",
        signal: abortController.signal,
      });
      return { response, abortController };
    } catch (error) {
      throw this.describeNetworkError(url, error);
    } finally {
      clearTimeout(headerTimer);
    }
  }

  private buildHeaders(referer: string | undefined, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": this.settings.userAgent,
      Accept: accept,
      "Accept-Language": "en-US,en;q=0.8,pt-BR;q=0.6",
    };
    if (referer) headers.Referer = referer;
    return headers;
  }

  /** Sleeps if the previous request to the same host was too recent. */
  private async waitForTurn(url: string): Promise<void> {
    const host = new URL(url).host;
    const lastRequestTime = this.lastRequestTimeByHost.get(host);
    if (lastRequestTime !== undefined) {
      const elapsedMs = Date.now() - lastRequestTime;
      const remainingMs = this.settings.delayBetweenRequestsMs - elapsedMs;
      if (remainingMs > 0) {
        logger.debug(`Waiting ${remainingMs} ms before the next request to ${host}`);
        await Bun.sleep(remainingMs);
      }
    }
    this.lastRequestTimeByHost.set(host, Date.now());
  }

  private describeNetworkError(url: string, error: unknown): RomkitError {
    const host = new URL(url).host;
    const errorName = (error as Error)?.name;
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      return new RomkitError(
        `${host} did not answer within ${Math.round(this.settings.timeoutMs / 1000)} s.`,
        "Try again later or increase http.timeoutMs in the config.",
      );
    }
    return new RomkitError(`Could not reach ${host}: ${(error as Error)?.message ?? String(error)}`);
  }
}
