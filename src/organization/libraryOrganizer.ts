/**
 * Puts a ROM unit into a system folder under its final name.
 *
 * - single file:  "<base>.<ext>"
 * - cue sheet:    "<base>.cue" + "<base>.bin" (one track)
 *                 or "<base> (Track 1).bin", "<base> (Track 2).bin"... (several tracks),
 *                 with the FILE lines inside the .cue rewritten to the new names.
 * - compressToZip: everything above, packed into "<base>.zip".
 *
 * If a target file already exists, the user chooses: overwrite, skip or keep both
 * (keep both adds " (2)", " (3)"... to the new name).
 */

import { unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Prompter } from "../cli/prompts";
import type { ReleasePreferences } from "../config/configTypes";
import { parseCueFileReferences, rewriteCueFileReferences, readCueSheet } from "../extraction/cueSheet";
import type { RomUnit } from "../extraction/romUnits";
import { createZipArchive } from "../extraction/sevenZip";
import { hashFile } from "../identification/fileHasher";
import { logger } from "../logging/logger";
import { sanitizeFileName } from "../naming/filenameSanitizer";
import { compareReleases } from "../naming/releasePreference";
import { parseRomName, type RomTag } from "../naming/tagParser";
import { LibraryIndex } from "./libraryIndex";
import {
  ensureDirectory,
  fileStem,
  isSamePath,
  lowercaseExtension,
  pathExists,
  removeDirectory,
  transferFile,
  type TransferMode,
} from "../util/fileSystem";

export interface PlacementRequest {
  unit: RomUnit;
  targetDirectory: string;
  /** Final name without extension, already sanitized. */
  baseName: string;
  transfer: TransferMode;
  compressToZip: boolean;
  sevenZipPath: string;
  /** Scratch folder used to assemble files before zipping. */
  stagingDirectory: string;
  /** --yes: never ask; existing files are skipped. */
  assumeYes: boolean;
  /**
   * The incoming unit's original release (name with tags, e.g. "Game (Europe) (Rev 1)").
   * When given, it is recorded in the library index, and a name clash with a file
   * whose release is known is resolved automatically: the preferred version stays,
   * the other goes to "_duplicates". Without it, clashes are asked about.
   */
  release?: { name: string; tags: RomTag[] };
  preferences?: ReleasePreferences;
}

export type PlacementResult =
  | { status: "placed"; placedPaths: string[] }
  /** The incoming unit lost against (or was identical to) the library copy and went to _duplicates. */
  | { status: "duplicate"; placedPaths: string[]; reason: string }
  | { status: "skipped" };

/** Folder (inside each system folder) where losing versions are kept for review. */
export const DUPLICATES_FOLDER_NAME = "_duplicates";

/** One file to place: where it comes from and its new name. */
export interface PlannedFile {
  sourcePath: string;
  targetName: string;
  /** For cue tracks: the name as written in the cue, so it can be rewritten. */
  cueReference?: string;
}

/** Computes the new names of every file in the unit (no disk access). */
export function planTargetNames(unit: RomUnit, baseName: string): PlannedFile[] {
  const primaryFile: PlannedFile = {
    sourcePath: unit.primaryFilePath,
    targetName: `${baseName}${lowercaseExtension(unit.primaryFilePath)}`,
  };
  if (unit.kind === "single") return [primaryFile];

  const trackCount = unit.cueReferences.length;
  // With 10+ tracks, pad numbers ("Track 01") so the files sort correctly.
  const digitCount = trackCount >= 10 ? 2 : 1;
  const trackFiles = unit.cueReferences.map((cueReference, trackIndex): PlannedFile => {
    const extension = lowercaseExtension(cueReference.filePath);
    const trackLabel = String(trackIndex + 1).padStart(digitCount, "0");
    const targetName = trackCount === 1 ? `${baseName}${extension}` : `${baseName} (Track ${trackLabel})${extension}`;
    return { sourcePath: cueReference.filePath, targetName, cueReference: cueReference.reference };
  });
  return [primaryFile, ...trackFiles];
}

export async function placeRomUnit(request: PlacementRequest, prompter: Prompter): Promise<PlacementResult> {
  await ensureDirectory(request.targetDirectory);
  let baseName = request.baseName;
  const libraryIndex = await LibraryIndex.load(request.targetDirectory);

  let conflictingPaths = await findConflicts(request, baseName);
  if (conflictingPaths.length > 0 && request.release && request.preferences && !request.compressToZip) {
    const decision = await decideBetweenVersions(request, conflictingPaths, libraryIndex);
    if (decision?.winner === "existing") {
      const duplicatePaths = await moveToDuplicates(request.unit, request.release.name, request.targetDirectory, request.transfer);
      logger.warn(`Duplicate: ${decision.reason}. The incoming copy went to ${DUPLICATES_FOLDER_NAME}.`);
      return { status: "duplicate", placedPaths: duplicatePaths, reason: decision.reason };
    }
    if (decision?.winner === "incoming") {
      await moveToDuplicates(decision.existingUnit, decision.existingReleaseName, request.targetDirectory, "move");
      libraryIndex.delete(basename(decision.existingUnit.primaryFilePath));
      logger.warn(`Replaced: ${decision.reason}. The previous copy went to ${DUPLICATES_FOLDER_NAME}.`);
      conflictingPaths = await findConflicts(request, baseName);
    }
  }

  if (conflictingPaths.length > 0) {
    const choice = request.assumeYes ? "skip" : await askConflictChoice(conflictingPaths, prompter);
    if (choice === "skip") {
      const verb = conflictingPaths.length === 1 ? "already exists" : "already exist";
      logger.warn(`Skipped: ${conflictingPaths.map((conflictPath) => basename(conflictPath)).join(", ")} ${verb}.`);
      return { status: "skipped" };
    }
    if (choice === "keep-both") {
      baseName = await findFreeBaseName(request, baseName);
      logger.info(`Keeping both; the new file will be named "${baseName}".`);
    } else {
      for (const conflictPath of conflictingPaths) {
        logger.debug(`Deleting existing ${conflictPath}`);
        await unlink(conflictPath);
      }
    }
  }

  const placedPaths = request.compressToZip
    ? [await placeAsZip(request, baseName)]
    : await placeFiles(request.unit, planTargetNames(request.unit, baseName), request.targetDirectory, request.transfer);

  if (request.release) {
    // A rename inside the same folder (organize): drop the record under the old name.
    if (isSamePath(dirname(request.unit.primaryFilePath), request.targetDirectory)) {
      libraryIndex.delete(basename(request.unit.primaryFilePath));
    }
    // The first placed path is the primary file (the .cue for disc images).
    libraryIndex.set(basename(placedPaths[0]!), { releaseName: request.release.name, addedAt: new Date().toISOString() });
    await libraryIndex.save();
  }
  return { status: "placed", placedPaths };
}

interface VersionDecision {
  winner: "incoming" | "existing";
  reason: string;
  existingUnit: RomUnit;
  existingReleaseName: string;
}

/**
 * Compares the incoming unit with the library file it clashes with.
 * Returns null when it cannot decide (the library file has no recorded release),
 * in which case the user is asked as usual.
 */
async function decideBetweenVersions(request: PlacementRequest, conflictingPaths: string[], libraryIndex: LibraryIndex): Promise<VersionDecision | null> {
  const incomingRelease = request.release!;
  const primaryTargetName = planTargetNames(request.unit, request.baseName)[0]!.targetName;
  const existingPrimaryPath = conflictingPaths.find((conflictPath) => basename(conflictPath).toLowerCase() === primaryTargetName.toLowerCase());
  if (!existingPrimaryPath) return null;

  const existingUnit = await unitFromLibraryFile(existingPrimaryPath);
  const existingEntry = libraryIndex.get(basename(existingPrimaryPath));
  const existingReleaseName = existingEntry?.releaseName ?? fileStem(existingPrimaryPath);

  // Same content: nothing to choose, the copy already in the library stays.
  const [incomingHashes, existingHashes] = await Promise.all([hashFile(hashableFile(request.unit)), hashFile(hashableFile(existingUnit))]);
  if (incomingHashes.sha1 === existingHashes.sha1) {
    // Same bytes, so the incoming release name also describes the library copy: remember it
    // when the library copy had no record (e.g. "Game.iso" is now known to be "Game (USA)").
    if (!existingEntry && incomingRelease.tags.length > 0) {
      libraryIndex.set(basename(existingPrimaryPath), { releaseName: incomingRelease.name, addedAt: new Date().toISOString() });
      await libraryIndex.save();
    }
    return { winner: "existing", reason: `identical to ${basename(existingPrimaryPath)} already in the library`, existingUnit, existingReleaseName };
  }

  // The existing file's release comes from the index or, failing that, from its own
  // name when it still carries tags ("Game (USA).iso"). With neither, the user decides.
  const existingTags = parseRomName(existingReleaseName).tags;
  if (!existingEntry && existingTags.length === 0) return null;

  const comparison = compareReleases(incomingRelease.tags, existingTags, request.preferences!);
  if (comparison > 0) {
    return { winner: "incoming", reason: `"${incomingRelease.name}" is preferred over "${existingReleaseName}"`, existingUnit, existingReleaseName };
  }
  const why = comparison < 0 ? "is preferred over" : "was there first and is as good as";
  return { winner: "existing", reason: `"${existingReleaseName}" ${why} "${incomingRelease.name}"`, existingUnit, existingReleaseName };
}

/** For a cue sheet the first track holds the data; the .cue text itself changes with renames. */
function hashableFile(unit: RomUnit): string {
  return unit.kind === "cue-sheet" ? (unit.cueReferences[0]?.filePath ?? unit.primaryFilePath) : unit.primaryFilePath;
}

/** Rebuilds the unit of a file already in the library (a .cue brings its tracks). */
async function unitFromLibraryFile(primaryPath: string): Promise<RomUnit> {
  if (lowercaseExtension(primaryPath) !== ".cue") return { kind: "single", primaryFilePath: primaryPath };
  const references = parseCueFileReferences(await readCueSheet(primaryPath));
  return {
    kind: "cue-sheet",
    primaryFilePath: primaryPath,
    cueReferences: references.map((reference) => ({ reference, filePath: resolve(dirname(primaryPath), reference) })),
  };
}

/**
 * Moves a unit into <system folder>\_duplicates under its release name
 * ("Mega Man Zero 4 (BR).gba"), so you can tell the versions apart when reviewing.
 */
async function moveToDuplicates(unit: RomUnit, releaseName: string, systemFolder: string, transfer: TransferMode): Promise<string[]> {
  const duplicatesFolder = join(systemFolder, DUPLICATES_FOLDER_NAME);
  await ensureDirectory(duplicatesFolder);
  const baseName = sanitizeFileName(releaseName);
  let candidateName = baseName;
  for (let copyNumber = 2; ; copyNumber++) {
    const targetPaths = planTargetNames(unit, candidateName).map((plannedFile) => join(duplicatesFolder, plannedFile.targetName));
    if (!(await Promise.all(targetPaths.map(pathExists))).some(Boolean)) break;
    candidateName = `${baseName} (${copyNumber})`;
  }
  return placeFiles(unit, planTargetNames(unit, candidateName), duplicatesFolder, transfer);
}

/** Paths that would be written for this base name (one zip, or every file of the unit). */
function targetPathsFor(request: PlacementRequest, baseName: string): string[] {
  if (request.compressToZip) return [join(request.targetDirectory, `${baseName}.zip`)];
  return planTargetNames(request.unit, baseName).map((plannedFile) => join(request.targetDirectory, plannedFile.targetName));
}

/**
 * Existing files that would be overwritten. A target that is one of the unit's
 * own source files is not a conflict: that happens when `organize` renames a
 * file in place, including case-only changes ("mega man.gba" → "Mega Man.gba").
 */
async function findConflicts(request: PlacementRequest, baseName: string): Promise<string[]> {
  const sourcePaths = [request.unit.primaryFilePath, ...(request.unit.kind === "cue-sheet" ? request.unit.cueReferences.map((cueReference) => cueReference.filePath) : [])];
  const conflictingPaths: string[] = [];
  for (const targetPath of targetPathsFor(request, baseName)) {
    const isOwnFile = sourcePaths.some((sourcePath) => isSamePath(sourcePath, targetPath));
    if (!isOwnFile && (await pathExists(targetPath))) conflictingPaths.push(targetPath);
  }
  return conflictingPaths;
}

async function askConflictChoice(conflictingPaths: string[], prompter: Prompter): Promise<"overwrite" | "skip" | "keep-both"> {
  for (const conflictPath of conflictingPaths) logger.warn(`Already in the library: ${conflictPath}`);
  return prompter.chooseKey("What should I do?", [
    { key: "overwrite", letter: "o", label: "overwrite" },
    { key: "skip", letter: "s", label: "skip" },
    { key: "keep-both", letter: "k", label: "keep both" },
  ]);
}

async function findFreeBaseName(request: PlacementRequest, baseName: string): Promise<string> {
  for (let copyNumber = 2; ; copyNumber++) {
    const candidateName = `${baseName} (${copyNumber})`;
    const targetPaths = targetPathsFor(request, candidateName);
    const anyTaken = (await Promise.all(targetPaths.map(pathExists))).some(Boolean);
    if (!anyTaken) return candidateName;
  }
}

/** Moves/copies the files into place, rewriting the cue sheet when there is one. */
async function placeFiles(unit: RomUnit, plannedFiles: PlannedFile[], targetDirectory: string, transfer: TransferMode): Promise<string[]> {
  const placedPaths: string[] = [];

  if (unit.kind === "single") {
    const plannedFile = plannedFiles[0]!;
    const targetPath = join(targetDirectory, plannedFile.targetName);
    await transferFile(plannedFile.sourcePath, targetPath, transfer);
    placedPaths.push(targetPath);
    return placedPaths;
  }

  // Read the cue BEFORE moving anything: the cue itself may be renamed in place.
  const originalCueText = await readCueSheet(unit.primaryFilePath);
  const [cueFile, ...trackFiles] = plannedFiles;

  const newNameByReference = new Map<string, string>();
  for (const trackFile of trackFiles) {
    const targetPath = join(targetDirectory, trackFile.targetName);
    await transferFile(trackFile.sourcePath, targetPath, transfer);
    placedPaths.push(targetPath);
    if (trackFile.cueReference) newNameByReference.set(trackFile.cueReference, trackFile.targetName);
  }

  // The cue is written fresh (not moved) because its content changes.
  const cueTargetPath = join(targetDirectory, cueFile!.targetName);
  await writeFile(cueTargetPath, rewriteCueFileReferences(originalCueText, newNameByReference), "utf8");
  if (transfer === "move" && !isSamePath(unit.primaryFilePath, cueTargetPath)) {
    await unlink(unit.primaryFilePath);
  }
  placedPaths.unshift(cueTargetPath);
  return placedPaths;
}

/** Assembles the renamed files in the staging folder, then zips them into the library. */
async function placeAsZip(request: PlacementRequest, baseName: string): Promise<string> {
  const stagingFolder = join(request.stagingDirectory, `zip-${Date.now()}`);
  await ensureDirectory(stagingFolder);
  try {
    const stagedPaths = await placeFiles(request.unit, planTargetNames(request.unit, baseName), stagingFolder, request.transfer);
    const zipPath = join(request.targetDirectory, `${baseName}.zip`);
    logger.info(`Compressing to ${basename(zipPath)}...`);
    await createZipArchive(request.sevenZipPath, zipPath, stagedPaths);
    return zipPath;
  } finally {
    await removeDirectory(stagingFolder);
  }
}
