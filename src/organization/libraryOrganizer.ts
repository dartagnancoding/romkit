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
import { basename, join } from "node:path";
import type { Prompter } from "../cli/prompts";
import { rewriteCueFileReferences, readCueSheet } from "../extraction/cueSheet";
import type { RomUnit } from "../extraction/romUnits";
import { createZipArchive } from "../extraction/sevenZip";
import { logger } from "../logging/logger";
import {
  ensureDirectory,
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
}

export type PlacementResult = { status: "placed"; placedPaths: string[] } | { status: "skipped" };

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

  const conflictingPaths = await findConflicts(request, baseName);
  if (conflictingPaths.length > 0) {
    const choice = request.assumeYes ? "skip" : await askConflictChoice(conflictingPaths, prompter);
    if (choice === "skip") {
      logger.warn(`Skipped: ${conflictingPaths.map((conflictPath) => basename(conflictPath)).join(", ")} already exists.`);
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
  return { status: "placed", placedPaths };
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
