/**
 * Groups loose files into "ROM units": the set of files that make up one game.
 *
 * - single:    one file, e.g. "game.gba", "game.chd", "game.iso".
 * - cue-sheet: a .cue plus the track files it references ("Track 1.bin", ...).
 *              They are renamed and moved together.
 *
 * Files whose extension is not accepted by the system (readmes, .nfo, .txt...)
 * are returned as discarded.
 */

import { dirname, extname, resolve } from "node:path";
import { lowercaseExtension } from "../util/fileSystem";
import { parseCueFileReferences, readCueSheet } from "./cueSheet";

export interface CueReference {
  /** File name as written in the cue sheet (may include a subfolder). */
  reference: string;
  filePath: string;
}

export type RomUnit =
  | { kind: "single"; primaryFilePath: string }
  | { kind: "cue-sheet"; primaryFilePath: string; cueReferences: CueReference[] };

export interface RomUnitScan {
  units: RomUnit[];
  discardedFilePaths: string[];
  /** Problems worth telling the user, e.g. a cue sheet pointing to a missing .bin. */
  warnings: string[];
}

export function unitFilePaths(unit: RomUnit): string[] {
  return unit.kind === "single" ? [unit.primaryFilePath] : [unit.primaryFilePath, ...unit.cueReferences.map((cueReference) => cueReference.filePath)];
}

export async function buildRomUnits(filePaths: string[], acceptedExtensions: string[]): Promise<RomUnitScan> {
  const accepted = new Set(acceptedExtensions.map((extension) => extension.toLowerCase()));
  // Windows is case-insensitive: "TRACK 1.BIN" in the cue must find "Track 1.bin" on disk.
  const filePathByLowerPath = new Map(filePaths.map((filePath) => [resolve(filePath).toLowerCase(), filePath]));
  const claimedLowerPaths = new Set<string>();
  const units: RomUnit[] = [];
  const warnings: string[] = [];

  // Cue sheets go first so their tracks are claimed before the single-file pass.
  // This matters for systems that also accept .bin on its own (e.g. Mega Drive).
  if (accepted.has(".cue")) {
    for (const cuePath of filePaths.filter((filePath) => lowercaseExtension(filePath) === ".cue")) {
      const references = parseCueFileReferences(await readCueSheet(cuePath));
      if (references.length === 0) {
        warnings.push(`Cue sheet "${cuePath}" lists no track files; ignored.`);
        claimedLowerPaths.add(resolve(cuePath).toLowerCase());
        continue;
      }

      const cueReferences: CueReference[] = [];
      let missingReference: string | null = null;
      for (const reference of references) {
        // resolve() also accepts absolute references (used by generated cue sheets).
        const lowerTrackPath = resolve(dirname(cuePath), reference).toLowerCase();
        const trackPath = filePathByLowerPath.get(lowerTrackPath);
        if (!trackPath) {
          missingReference = reference;
          break;
        }
        // The same track file can appear in more than one FILE line; keep it once.
        if (!cueReferences.some((existing) => existing.filePath === trackPath)) {
          cueReferences.push({ reference, filePath: trackPath });
        }
      }

      claimedLowerPaths.add(resolve(cuePath).toLowerCase());
      if (missingReference !== null) {
        warnings.push(`Cue sheet "${cuePath}" references "${missingReference}", which is missing; ignored.`);
        continue;
      }
      for (const cueReference of cueReferences) claimedLowerPaths.add(resolve(cueReference.filePath).toLowerCase());
      units.push({ kind: "cue-sheet", primaryFilePath: cuePath, cueReferences });
    }
  }

  const discardedFilePaths: string[] = [];
  for (const filePath of filePaths) {
    if (claimedLowerPaths.has(resolve(filePath).toLowerCase())) continue;
    const extension = extname(filePath).toLowerCase();
    if (accepted.has(extension) && extension !== ".cue") {
      units.push({ kind: "single", primaryFilePath: filePath });
    } else {
      discardedFilePaths.push(filePath);
    }
  }

  return { units, discardedFilePaths, warnings };
}
