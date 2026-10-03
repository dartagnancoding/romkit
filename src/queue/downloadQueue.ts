/**
 * The download queue: games chosen with `romkit queue add`, plus downloads that
 * `romkit download` started and did not finish. Kept next to the config
 * (romkit.queue.json) rather than in the temp folder, so the list survives a
 * temp cleanup; the partial files themselves live in <tempDirectory>\partial.
 *
 * Every change re-reads the file first and replaces it atomically, so two romkit
 * windows touching the queue do not lose each other's items.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SearchResult } from "../sources/sourceAdapter";
import { ensureDirectory } from "../util/fileSystem";

export const QUEUE_FILE_NAME = "romkit.queue.json";

export interface QueueItem {
  id: string;
  systemId: string;
  /** What was typed, used as an identification hint. */
  query: string;
  /** The result chosen when the item was added; the download URL is resolved from it when it runs. */
  result: SearchResult;
  /** Filled once the download starts; locates the partial file. */
  downloadUrl?: string;
  /** "pending": not started. "unfinished": started and not completed (interrupted, failed, or running elsewhere). */
  status: "pending" | "unfinished";
  addedAt: string;
  lastError?: string;
}

export class DownloadQueue {
  private updateChain: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  static besideConfig(configPath: string): DownloadQueue {
    return new DownloadQueue(join(dirname(configPath), QUEUE_FILE_NAME));
  }

  async list(): Promise<QueueItem[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { items?: QueueItem[] };
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  }

  /** Adds an item, or returns the existing one for the same game page and system. */
  async add(item: Omit<QueueItem, "id" | "addedAt">): Promise<{ item: QueueItem; alreadyQueued: boolean }> {
    let outcome!: { item: QueueItem; alreadyQueued: boolean };
    await this.update((items) => {
      const existing = items.find((candidate) => candidate.result.pageUrl === item.result.pageUrl && candidate.systemId === item.systemId);
      if (existing) {
        outcome = { item: existing, alreadyQueued: true };
        return items;
      }
      const newItem: QueueItem = { ...item, id: randomUUID().slice(0, 8), addedAt: new Date().toISOString() };
      outcome = { item: newItem, alreadyQueued: false };
      return [...items, newItem];
    });
    return outcome;
  }

  async patch(id: string, changes: Partial<Omit<QueueItem, "id">>): Promise<void> {
    await this.update((items) => items.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }

  async remove(ids: string[]): Promise<void> {
    const removed = new Set(ids);
    await this.update((items) => items.filter((item) => !removed.has(item.id)));
  }

  /** Serialized within this process; read-modify-write against the file each time. */
  private update(change: (items: QueueItem[]) => QueueItem[]): Promise<void> {
    const run = this.updateChain.then(async () => {
      const items = change(await this.list());
      await ensureDirectory(dirname(this.filePath));
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    this.updateChain = run.catch(() => {});
    return run;
  }
}
