/**
 * User-editable nicknames → real titles (romkit.aliases.json).
 *
 *   {
 *     "*":   { "SMB3": "Super Mario Bros. 3" },      ← valid for every system
 *     "GBA": { "MMZ4": "Mega Man Zero 4" }            ← only for GBA
 *   }
 *
 * Keys are compared after normalization, so "mmz4", "MMZ4" and "MMZ 4" match the same entry.
 */

import { readFile } from "node:fs/promises";
import { parseJsonWithComments } from "../config/jsonc";
import { RomkitError } from "../errors";
import { logger } from "../logging/logger";
import { compactKey } from "../naming/titleNormalization";
import { pathExists } from "../util/fileSystem";

const GLOBAL_SCOPE = "*";

export class AliasTable {
  private constructor(
    /** Scope (system id in uppercase, or "*") → compact alias key → title. */
    private readonly titlesByScope: Map<string, Map<string, string>>,
  ) {}

  static empty(): AliasTable {
    return new AliasTable(new Map());
  }

  static async load(filePath: string): Promise<AliasTable> {
    if (!(await pathExists(filePath))) {
      logger.debug(`No alias file at ${filePath}`);
      return AliasTable.empty();
    }

    // Comments and trailing commas are allowed, like in the config file.
    const parsed = parseJsonWithComments(await readFile(filePath, "utf8"), filePath);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new RomkitError(`The alias file ${filePath} must be an object like { "GBA": { "MMZ4": "Mega Man Zero 4" } }.`);
    }

    const titlesByScope = new Map<string, Map<string, string>>();
    for (const [scope, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
        throw new RomkitError(`In ${filePath}, "${scope}" must map aliases to titles.`);
      }
      const titlesByKey = new Map<string, string>();
      for (const [alias, title] of Object.entries(entries as Record<string, unknown>)) {
        if (typeof title !== "string" || title.trim() === "") {
          throw new RomkitError(`In ${filePath}, alias "${alias}" (${scope}) must map to a title.`);
        }
        titlesByKey.set(compactKey(alias), title.trim());
      }
      titlesByScope.set(scope.toUpperCase(), titlesByKey);
    }
    return new AliasTable(titlesByScope);
  }

  /** System-specific aliases win over global ones. */
  lookup(systemId: string, text: string): string | null {
    const key = compactKey(text);
    if (key === "") return null;
    return this.titlesByScope.get(systemId.toUpperCase())?.get(key) ?? this.titlesByScope.get(GLOBAL_SCOPE)?.get(key) ?? null;
  }
}
