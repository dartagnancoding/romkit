/**
 * Shared pipeline for `download` and `import`, once a file is on disk:
 *
 *   detect archive (magic bytes) → extract with 7-Zip → keep accepted files
 *   → pick one ROM (ask if several) → identify → confirm name → place in library
 */

import { readdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { ParsedFlags } from "../cli/argumentParser";
import { confirmRomName } from "../cli/nameConfirmation";
import type { Prompter } from "../cli/prompts";
import { style } from "../cli/terminalStyle";
import type { ResolvedConfig, ResolvedSystem } from "../config/configTypes";
import type { Workspace } from "../download/tempWorkspace";
import { RomkitError } from "../errors";
import { detectArchiveFormat } from "../extraction/archiveDetector";
import { buildRomUnits, unitFilePaths, type RomUnit } from "../extraction/romUnits";
import { extractArchive } from "../extraction/sevenZip";
import { identifyRomUnit, loadIdentificationContext } from "../identification/romIdentifier";
import { logger } from "../logging/logger";
import { placeRomUnit } from "../organization/libraryOrganizer";
import { fileStem, listFilesRecursive, lowercaseExtension, type TransferMode } from "../util/fileSystem";
import { formatBytes } from "../util/format";

export interface ProcessOptions {
  system: ResolvedSystem;
  config: ResolvedConfig;
  prompter: Prompter;
  flags: ParsedFlags;
  workspace: Workspace;
  /** Extra names that may describe the game (search result title, query...). */
  hints: string[];
  /**
   * The input file may be removed once the ROM is in the library: true for
   * downloads (it lives in the temp folder), true for `import --delete-source`.
   */
  removeSourceWhenDone: boolean;
}

export type ProcessOutcome = "placed" | "skipped";

/** Archives inside archives are extracted this many levels deep at most. */
const MAX_NESTED_ARCHIVE_DEPTH = 2;

export async function processAcquiredFile(inputPath: string, options: ProcessOptions): Promise<ProcessOutcome> {
  const { system, config, workspace } = options;

  const archiveFormat = await detectArchiveFormat(inputPath);
  let candidateFiles: string[];
  let transfer: TransferMode;

  if (archiveFormat) {
    const declaredExtension = lowercaseExtension(inputPath);
    if (declaredExtension !== `.${archiveFormat}`) {
      logger.debug(`File is a ${archiveFormat} archive despite its "${declaredExtension || "(none)"}" extension.`);
    }
    logger.info(`Extracting ${archiveFormat} archive...`);
    candidateFiles = await extractRecursively(inputPath, workspace.extractionDirectory, system, config.sevenZipPath);
    // Extracted files live in the temp folder, so they can simply be moved.
    transfer = "move";
  } else {
    candidateFiles = await collectRawInputFiles(inputPath);
    transfer = options.removeSourceWhenDone ? "move" : "copy";
  }

  const scan = await buildRomUnits(candidateFiles, system.extensions);
  for (const warning of scan.warnings) logger.warn(warning);

  // For a raw .cue import, sibling files were only added to resolve its tracks:
  // the unit of interest is the one whose primary file is the input itself.
  const units = archiveFormat ? scan.units : scan.units.filter((unit) => unit.primaryFilePath === inputPath);
  const discardedFiles = archiveFormat ? scan.discardedFilePaths : scan.discardedFilePaths.filter((filePath) => filePath === inputPath);

  if (discardedFiles.length > 0) {
    const discardedNames = discardedFiles.map((filePath) => basename(filePath));
    logger.info(style.dim(`Discarded ${discardedNames.length} file(s) not accepted for ${system.id}: ${discardedNames.join(", ")}`));
  }

  if (units.length === 0) {
    throw new RomkitError(
      `No valid ${system.id} ROM found (accepted: ${system.extensions.join(", ")}). Nothing was moved.`,
      archiveFormat ? "Use --keep-temp to inspect what the archive contained." : undefined,
    );
  }

  const chosenUnit = await chooseUnit(units, options.prompter);
  if (!chosenUnit) {
    logger.info("Cancelled; nothing was moved.");
    return "skipped";
  }

  const identificationContext = await loadIdentificationContext(system, config);
  const archiveHint = archiveFormat ? [fileStem(inputPath)] : [];
  const identification = await identifyRomUnit(chosenUnit, [...options.hints, ...archiveHint], identificationContext);

  const baseName = await confirmRomName(identification, system, options.prompter, {
    originalName: basename(chosenUnit.primaryFilePath),
    autoAcceptThreshold: config.autoAcceptThreshold,
    assumeYes: options.flags.yes,
  });
  if (baseName === null) {
    logger.info("Skipped; nothing was moved.");
    return "skipped";
  }

  const placement = await placeRomUnit(
    {
      unit: chosenUnit,
      targetDirectory: system.folderPath,
      baseName,
      transfer,
      compressToZip: system.compressToZip,
      sevenZipPath: config.sevenZipPath,
      stagingDirectory: workspace.stagingDirectory,
      assumeYes: options.flags.yes,
    },
    options.prompter,
  );
  if (placement.status === "skipped") return "skipped";

  for (const placedPath of placement.placedPaths) logger.success(`Saved: ${placedPath}`);

  // For raw input the files were already moved (transfer "move"); only the archive remains.
  if (archiveFormat && options.removeSourceWhenDone) {
    await unlink(inputPath).catch((error) => logger.warn(`Could not delete ${inputPath}: ${(error as Error).message}`));
  }
  return "placed";
}

/**
 * Extracts an archive; if it contains no accepted file but does contain other
 * archives (a zip inside a zip), extracts those too, up to a small depth.
 */
async function extractRecursively(archivePath: string, outputDirectory: string, system: ResolvedSystem, sevenZipPath: string): Promise<string[]> {
  let currentArchives = [archivePath];
  let extractedFiles: string[] = [];

  for (let depth = 0; depth < MAX_NESTED_ARCHIVE_DEPTH && currentArchives.length > 0; depth++) {
    const nextArchives: string[] = [];
    for (const [archiveIndex, currentArchive] of currentArchives.entries()) {
      const levelDirectory = join(outputDirectory, `level${depth}-${archiveIndex}`);
      await extractArchive(sevenZipPath, currentArchive, levelDirectory);
      const levelFiles = await listFilesRecursive(levelDirectory);
      extractedFiles.push(...levelFiles);
      for (const levelFile of levelFiles) {
        if (await detectArchiveFormat(levelFile)) nextArchives.push(levelFile);
      }
    }
    const hasAcceptedFile = extractedFiles.some((filePath) => system.extensions.includes(extname(filePath).toLowerCase()));
    if (hasAcceptedFile || nextArchives.length === 0) break;
    logger.debug(`No ${system.id} file found; extracting ${nextArchives.length} nested archive(s).`);
    // Nested archives were already counted as files; drop them from the candidate list.
    extractedFiles = extractedFiles.filter((filePath) => !nextArchives.includes(filePath));
    currentArchives = nextArchives;
  }
  return extractedFiles;
}

/** A raw .cue needs its sibling files (the tracks); any other raw file stands alone. */
async function collectRawInputFiles(inputPath: string): Promise<string[]> {
  if (lowercaseExtension(inputPath) !== ".cue") return [inputPath];
  const directory = dirname(inputPath);
  const entries = await readdir(directory, { withFileTypes: true });
  const siblingFiles = entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name));
  return [inputPath, ...siblingFiles.filter((filePath) => filePath !== inputPath)];
}

async function chooseUnit(units: RomUnit[], prompter: Prompter): Promise<RomUnit | null> {
  if (units.length === 1) return units[0]!;
  const labels = await Promise.all(
    units.map(async (unit) => {
      const sizes = await Promise.all(unitFilePaths(unit).map((filePath) => Bun.file(filePath).size));
      const totalSize = sizes.reduce((sum, size) => sum + size, 0);
      return `${basename(unit.primaryFilePath)}  ${style.dim(formatBytes(totalSize))}`;
    }),
  );
  const chosenIndex = await prompter.chooseFromList(`The archive contains ${units.length} valid ROMs. Which one do you want to keep?`, labels);
  return chosenIndex === null ? null : units[chosenIndex]!;
}
