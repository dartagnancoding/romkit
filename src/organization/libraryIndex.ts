/**
 * Small per-folder record of where each library file came from.
 *
 * Final names drop the tags ("Mega Man Zero 4 (BR).gba" becomes "Mega Man Zero 4.gba"),
 * so without this record romkit could not tell later whether the file in the
 * library is the USA release or a translation. Stored as
 * `<system folder>\.romkit-index.json`:
 *
 *   { "version": 1, "entries": { "Mega Man Zero 4.gba": {
 *       "releaseName": "Mega Man Zero 4 (BR)", "addedAt": "2026-10-02T...",
 *       "crc32": "...", "sha1": "...", "verified": true } } }
 *
 * Missing or unreadable index → treated as empty (older libraries simply have no history).
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logging/logger";
import { pathExists } from "../util/fileSystem";

export const LIBRARY_INDEX_FILE_NAME = ".romkit-index.json";

export interface LibraryIndexEntry {
  /** Original release name with tags, e.g. "Mega Man Zero 4 (Europe) (Rev 1)". */
  releaseName: string;
  addedAt: string;
  crc32?: string;
  sha1?: string;
  /** Result of the last DAT check: true = known good dump, false = not in the DAT. */
  verified?: boolean;
}

interface LibraryIndexFile {
  version: 1;
  entries: Record<string, LibraryIndexEntry>;
}

export class LibraryIndex {
  private constructor(
    private readonly indexPath: string,
    /** Keyed by lowercase file name: Windows names are case-insensitive. */
    private readonly entriesByLowerName: Map<string, { fileName: string; entry: LibraryIndexEntry }>,
  ) {}

  static async load(folderPath: string): Promise<LibraryIndex> {
    const indexPath = join(folderPath, LIBRARY_INDEX_FILE_NAME);
    const entries = new Map<string, { fileName: string; entry: LibraryIndexEntry }>();
    if (await pathExists(indexPath)) {
      try {
        const parsed = JSON.parse(await readFile(indexPath, "utf8")) as LibraryIndexFile;
        for (const [fileName, entry] of Object.entries(parsed.entries ?? {})) {
          entries.set(fileName.toLowerCase(), { fileName, entry });
        }
      } catch (error) {
        logger.warn(`Ignoring unreadable library index ${indexPath}: ${(error as Error).message}`);
      }
    }
    return new LibraryIndex(indexPath, entries);
  }

  get(fileName: string): LibraryIndexEntry | null {
    return this.entriesByLowerName.get(fileName.toLowerCase())?.entry ?? null;
  }

  set(fileName: string, entry: LibraryIndexEntry): void {
    this.entriesByLowerName.set(fileName.toLowerCase(), { fileName, entry });
  }

  /** Keeps the history when `organize` renames a file. */
  rename(oldFileName: string, newFileName: string): void {
    const record = this.entriesByLowerName.get(oldFileName.toLowerCase());
    if (!record) return;
    this.entriesByLowerName.delete(oldFileName.toLowerCase());
    this.entriesByLowerName.set(newFileName.toLowerCase(), { fileName: newFileName, entry: record.entry });
  }

  delete(fileName: string): void {
    this.entriesByLowerName.delete(fileName.toLowerCase());
  }

  async save(): Promise<void> {
    const sortedRecords = [...this.entriesByLowerName.values()].sort((first, second) => first.fileName.localeCompare(second.fileName));
    const file: LibraryIndexFile = {
      version: 1,
      entries: Object.fromEntries(sortedRecords.map((record) => [record.fileName, record.entry])),
    };
    await writeFile(this.indexPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}
