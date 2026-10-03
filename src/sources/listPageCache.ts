/**
 * Disk cache for list pages (sources without {query} in their URL).
 *
 * Such a page is the same for every search and changes rarely (an archive.org
 * file index, for instance), so it is kept for a while instead of being fetched
 * again on every `romkit download`. Search pages are never cached.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logging/logger";
import type { FetchedPage } from "./httpClient";

export const LIST_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  savedAt: number;
  page: FetchedPage;
}

export class ListPageCache {
  constructor(
    private readonly directory: string,
    private readonly maxAgeMs = LIST_CACHE_MAX_AGE_MS,
  ) {}

  /** The cached page, or null when missing, expired or unreadable. */
  async read(url: string): Promise<FetchedPage | null> {
    try {
      const entry = JSON.parse(await readFile(this.filePathFor(url), "utf8")) as CacheEntry;
      if (Date.now() - entry.savedAt > this.maxAgeMs) return null;
      logger.debug(`Cached list page (${Math.round((Date.now() - entry.savedAt) / 3_600_000)}h old): ${url}`);
      return entry.page;
    } catch {
      return null;
    }
  }

  async write(page: FetchedPage): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      const entry: CacheEntry = { savedAt: Date.now(), page };
      await writeFile(this.filePathFor(page.requestedUrl), JSON.stringify(entry), "utf8");
    } catch (error) {
      // A cache that cannot be written only costs speed.
      logger.debug(`Could not cache ${page.requestedUrl}: ${String(error)}`);
    }
  }

  private filePathFor(url: string): string {
    return join(this.directory, `${createHash("sha1").update(url).digest("hex")}.json`);
  }
}
