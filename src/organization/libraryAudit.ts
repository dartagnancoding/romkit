/**
 * Read-only health check of a system folder. Nothing is moved or renamed here;
 * the audit only reports what `organize` (or a manual cleanup) would fix:
 *
 *   - duplicates: several files that are the same game (same final name),
 *     with the version that would be kept and why;
 *   - names that do not follow the naming standard;
 *   - files not verified by the DAT (when the system has one);
 *   - other files lying in the folder (readmes, saves, leftovers...).
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { statusLine } from "../cli/progressBar";
import type { ResolvedConfig, ResolvedSystem } from "../config/configTypes";
import { buildRomUnits, type RomUnit } from "../extraction/romUnits";
import { hashFile } from "../identification/fileHasher";
import { identifyRomUnit, loadIdentificationContext, type IdentificationResult } from "../identification/romIdentifier";
import { formatRomBaseName } from "../naming/nameFormatter";
import { compareReleases, explainPreference } from "../naming/releasePreference";
import { parseRomName } from "../naming/tagParser";
import { compactKey } from "../naming/titleNormalization";
import { fileStem, listFilesShallow, lowercaseExtension } from "../util/fileSystem";
import { LIBRARY_INDEX_FILE_NAME, LibraryIndex } from "./libraryIndex";

export interface AuditedRom {
  unit: RomUnit;
  fileName: string;
  /** Original release (index record, or the current name while it still has tags). */
  releaseName: string;
  suggestedFileName: string;
  identification: IdentificationResult;
  /** null when the system has no DAT. */
  verified: boolean | null;
}

export interface DuplicateGroup {
  keeper: AuditedRom;
  setAside: { rom: AuditedRom; reason: string }[];
}

export interface AuditReport {
  system: ResolvedSystem;
  folderPath: string;
  roms: AuditedRom[];
  duplicateGroups: DuplicateGroup[];
  /** ROMs (not set aside as duplicates) whose name differs from the standard. */
  renames: AuditedRom[];
  unverified: AuditedRom[];
  hasDat: boolean;
  otherFiles: string[];
}

export async function auditFolder(system: ResolvedSystem, folderPath: string, config: ResolvedConfig): Promise<AuditReport> {
  const files = await listFilesShallow(folderPath);
  const scan = await buildRomUnits(files, system.extensions);
  const identificationContext = await loadIdentificationContext(system, config);
  const libraryIndex = await LibraryIndex.load(folderPath);
  const hasDat = identificationContext.datIndex !== null;

  const roms: AuditedRom[] = [];
  for (const [unitIndex, unit] of scan.units.entries()) {
    const fileName = basename(unit.primaryFilePath);
    statusLine.update(`Auditing ${system.id} ${unitIndex + 1}/${scan.units.length}: ${fileName}`);
    const releaseName = libraryIndex.get(fileName)?.releaseName ?? fileStem(unit.primaryFilePath);
    const identification = await identifyRomUnit(unit, [releaseName], identificationContext);
    roms.push({
      unit,
      fileName,
      releaseName,
      suggestedFileName: `${formatRomBaseName(identification, system.naming, system.id)}${lowercaseExtension(unit.primaryFilePath)}`,
      identification,
      verified: hasDat ? identification.method === "hash" : null,
    });
  }
  statusLine.clear();

  const duplicateGroups = await findDuplicateGroups(roms, system);
  const setAsideRoms = new Set(duplicateGroups.flatMap((group) => group.setAside.map((entry) => entry.rom)));
  const keptRoms = roms.filter((rom) => !setAsideRoms.has(rom));

  return {
    system,
    folderPath,
    roms,
    duplicateGroups,
    renames: keptRoms.filter((rom) => rom.fileName !== rom.suggestedFileName),
    unverified: keptRoms.filter((rom) => rom.verified === false),
    hasDat,
    otherFiles: scan.discardedFilePaths.map((filePath) => basename(filePath)).filter((fileName) => fileName !== LIBRARY_INDEX_FILE_NAME),
  };
}

/**
 * Files whose standardized names collide are the same game. Inside each group,
 * the best release (by the system's preferences) is the keeper; byte-identical
 * copies are reported as such.
 */
async function findDuplicateGroups(roms: AuditedRom[], system: ResolvedSystem): Promise<DuplicateGroup[]> {
  const romsByGame = new Map<string, AuditedRom[]>();
  for (const rom of roms) {
    // compactKey also merges spelling variants such as "DragonBall Z" / "Dragon Ball Z".
    const gameKey = `${compactKey(fileStem(rom.suggestedFileName))}${lowercaseExtension(rom.fileName)}`;
    romsByGame.set(gameKey, [...(romsByGame.get(gameKey) ?? []), rom]);
  }

  const groups: DuplicateGroup[] = [];
  for (const sameGameRoms of romsByGame.values()) {
    if (sameGameRoms.length < 2) continue;
    // Best first; on a tie, keep the file that already has the standard name.
    const ranked = [...sameGameRoms].sort(
      (first, second) =>
        compareReleases(parseRomName(second.releaseName).tags, parseRomName(first.releaseName).tags, system.preferences) ||
        Number(second.fileName === second.suggestedFileName) - Number(first.fileName === first.suggestedFileName),
    );
    let keeper = ranked[0]!;
    const setAside = [];
    for (const rom of ranked.slice(1)) {
      const identical = await isSameContent(keeper, rom);
      if (identical && rom.fileName === rom.suggestedFileName && keeper.fileName !== keeper.suggestedFileName) {
        // Same bytes: keep the copy that already has the standard name, exactly as
        // `organize` will do (it never replaces a file with an identical one).
        setAside.push({ rom: keeper, reason: "identical copy" });
        keeper = rom;
        continue;
      }
      const reason = identical
        ? "identical copy"
        : explainPreference(parseRomName(keeper.releaseName).tags, parseRomName(rom.releaseName).tags, system.preferences);
      setAside.push({ rom, reason });
    }
    groups.push({ keeper, setAside });
  }
  return groups;
}

/** Size first (instant), checksum only when sizes match. */
async function isSameContent(first: AuditedRom, second: AuditedRom): Promise<boolean> {
  const firstPath = hashableFile(first.unit);
  const secondPath = hashableFile(second.unit);
  const [firstStats, secondStats] = await Promise.all([stat(firstPath), stat(secondPath)]);
  if (firstStats.size !== secondStats.size) return false;
  const [firstHashes, secondHashes] = await Promise.all([hashFile(firstPath), hashFile(secondPath)]);
  return firstHashes.sha1 === secondHashes.sha1;
}

function hashableFile(unit: RomUnit): string {
  return unit.kind === "cue-sheet" ? (unit.cueReferences[0]?.filePath ?? unit.primaryFilePath) : unit.primaryFilePath;
}

/** Arcade folders are only checked for files that are not romset archives. */
export async function auditArcadeFolder(system: ResolvedSystem, folderPath: string): Promise<{ romsetCount: number; otherFiles: string[] }> {
  const files = await listFilesShallow(folderPath);
  const isRomset = (filePath: string) => system.extensions.includes(lowercaseExtension(filePath));
  return {
    romsetCount: files.filter(isRomset).length,
    otherFiles: files.filter((filePath) => !isRomset(filePath)).map((filePath) => basename(filePath)).filter((fileName) => fileName !== LIBRARY_INDEX_FILE_NAME),
  };
}
