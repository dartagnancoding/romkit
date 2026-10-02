/**
 * Shared pipeline for `download` and `import`, once a file is on disk:
 *
 *   detect archive (magic bytes) → extract with 7-Zip → keep accepted files
 *   → pick one ROM (ask if several) → identify → confirm name → place in library
 */

import { readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
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
import { detectRomExtension } from "../extraction/romSignatures";
import { parseCueFileReferences, readCueSheet, writeCueForBin } from "../extraction/cueSheet";
import { isRawCdImage, PLATFORM_HEADER_LENGTH, rawCdTrackMode } from "../extraction/platformDetector";
import { identifyRomUnit, loadIdentificationContext } from "../identification/romIdentifier";
import { logger } from "../logging/logger";
import { placeRomUnit } from "../organization/libraryOrganizer";
import { fileStem, listFilesRecursive, lowercaseExtension, transferFile, type TransferMode } from "../util/fileSystem";
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
  if (options.system.mode === "arcade") return placeArcadeRomset(inputPath, options);

  const { system, config, workspace } = options;

  const archiveFormat = await detectArchiveFormat(inputPath);
  let candidateFiles: string[];
  let transfer: TransferMode;
  /** For raw input: the file whose unit we want (the input, or a cue generated for it). */
  let primaryOfInterest = inputPath;

  if (archiveFormat) {
    const declaredExtension = lowercaseExtension(inputPath);
    if (declaredExtension !== `.${archiveFormat}`) {
      logger.debug(`File is a ${archiveFormat} archive despite its "${declaredExtension || "(none)"}" extension.`);
    }
    logger.info(`Extracting ${archiveFormat} archive...`);
    candidateFiles = await extractRecursively(inputPath, workspace.extractionDirectory, system, config.sevenZipPath);
    candidateFiles = await rescueFilesWithoutExtension(candidateFiles, system);
    candidateFiles = await addCueSheetsForLoneCdImages(candidateFiles, system, null);
    // Extracted files live in the temp folder, so they can simply be moved.
    transfer = "move";
  } else {
    candidateFiles = await collectRawInputFiles(inputPath);
    // A lone CD .bin gets a cue generated in the temp folder, so the input folder stays untouched.
    const withGeneratedCue = await addCueSheetsForLoneCdImages([inputPath], system, workspace.extractionDirectory);
    const generatedCue = withGeneratedCue.find((filePath) => filePath !== inputPath);
    if (generatedCue) {
      candidateFiles = [generatedCue, inputPath];
      primaryOfInterest = generatedCue;
    }
    transfer = options.removeSourceWhenDone ? "move" : "copy";
  }

  const scan = await buildRomUnits(candidateFiles, system.extensions);
  for (const warning of scan.warnings) logger.warn(warning);

  // For a raw .cue import, sibling files were only added to resolve its tracks:
  // the unit of interest is the one whose primary file is the input itself.
  const units = archiveFormat ? scan.units : scan.units.filter((unit) => unit.primaryFilePath === primaryOfInterest);
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
 * Old dumps sometimes have no (or a wrong) extension, e.g. "GE00" for GoldenEye.
 * Files whose extension is not accepted are checked by header; when the header
 * reveals an accepted ROM type, the file is renamed in the temp folder
 * ("GE00" → "GE00.z64") so the normal flow picks it up.
 */
async function rescueFilesWithoutExtension(filePaths: string[], system: ResolvedSystem): Promise<string[]> {
  const resultPaths: string[] = [];
  for (const filePath of filePaths) {
    if (system.extensions.includes(lowercaseExtension(filePath))) {
      resultPaths.push(filePath);
      continue;
    }
    const detected = await detectRomExtension(filePath);
    if (!detected || !system.extensions.includes(detected.extension)) {
      resultPaths.push(filePath);
      continue;
    }
    const renamedPath = join(dirname(filePath), `${fileStem(filePath)}${detected.extension}`);
    await rename(filePath, renamedPath);
    logger.info(`Recognized ${basename(filePath)} as a ${detected.description} ROM by its header.`);
    resultPaths.push(renamedPath);
  }
  return resultPaths;
}

/** Matches "Track 2", "(Track 02)"... i.e. tracks after the first, which never stand alone. */
const LATER_TRACK_PATTERN = /track\s*0*([2-9]|\d{2,})\b/i;

/**
 * A raw CD .bin without a .cue (e.g. a single-track PS1 game) cannot be used as
 * is by systems that expect cue sheets. When the .bin really is a raw CD image
 * and no cue in the list references it, a minimal cue sheet is generated for it.
 * Returns the file list with the generated cue sheets added.
 */
async function addCueSheetsForLoneCdImages(filePaths: string[], system: ResolvedSystem, cueDirectory: string | null): Promise<string[]> {
  const systemNeedsCue = system.extensions.includes(".cue") && !system.extensions.includes(".bin");
  if (!systemNeedsCue) return filePaths;

  const referencedLowerPaths = new Set<string>();
  for (const cuePath of filePaths.filter((filePath) => lowercaseExtension(filePath) === ".cue")) {
    for (const reference of parseCueFileReferences(await readCueSheet(cuePath))) {
      referencedLowerPaths.add(resolve(dirname(cuePath), reference).toLowerCase());
    }
  }

  const resultPaths = [...filePaths];
  for (const binPath of filePaths) {
    if (lowercaseExtension(binPath) !== ".bin" || referencedLowerPaths.has(resolve(binPath).toLowerCase())) continue;
    if (LATER_TRACK_PATTERN.test(fileStem(binPath))) continue;
    const header = new Uint8Array(await Bun.file(binPath).slice(0, PLATFORM_HEADER_LENGTH).arrayBuffer());
    if (!isRawCdImage(header)) continue;
    const cuePath = await writeCueForBin(binPath, cueDirectory ?? dirname(binPath), rawCdTrackMode(header));
    logger.info(`${basename(binPath)} had no .cue; generated one (${rawCdTrackMode(header)}).`);
    resultPaths.push(cuePath);
  }
  return resultPaths;
}

/** MAME short names: lowercase letters, digits and underscores ("sf2", "mslug3h"). */
const ARCADE_SHORT_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * Arcade systems (MAME/FBNeo): the zip/7z is the romset itself. It is moved into
 * the library unchanged: no extraction, no identification, no renaming, since the
 * emulator finds games by the exact short file name ("sf2.zip").
 */
async function placeArcadeRomset(inputPath: string, options: ProcessOptions): Promise<ProcessOutcome> {
  const { system, config, workspace } = options;

  const archiveFormat = await detectArchiveFormat(inputPath);
  if (archiveFormat !== "zip" && archiveFormat !== "7z") {
    throw new RomkitError(
      `${basename(inputPath)} is not a zip or 7z file${archiveFormat ? ` (it is ${archiveFormat})` : ""}; arcade romsets must be .zip or .7z.`,
      archiveFormat === "rar" ? "Extract it and import the .zip inside." : undefined,
    );
  }

  // Downloaded files sometimes carry the wrong extension; give it the right one.
  let romsetPath = inputPath;
  let transfer: TransferMode = options.removeSourceWhenDone ? "move" : "copy";
  const expectedExtension = `.${archiveFormat}`;
  if (lowercaseExtension(inputPath) !== expectedExtension) {
    romsetPath = join(workspace.downloadDirectory, `${fileStem(inputPath)}${expectedExtension}`);
    await transferFile(inputPath, romsetPath, transfer);
    transfer = "move";
  }

  const shortName = fileStem(romsetPath);
  if (!ARCADE_SHORT_NAME_PATTERN.test(shortName)) {
    logger.warn(
      `"${shortName}" does not look like a MAME short name (e.g. "sf2", "mslug"). ` +
        "The emulator may not find it; rename it to the romset's short name if needed.",
    );
  }

  const placement = await placeRomUnit(
    {
      unit: { kind: "single", primaryFilePath: romsetPath },
      targetDirectory: system.folderPath,
      baseName: shortName,
      transfer,
      compressToZip: false,
      sevenZipPath: config.sevenZipPath,
      stagingDirectory: workspace.stagingDirectory,
      assumeYes: options.flags.yes,
    },
    options.prompter,
  );
  if (placement.status === "skipped") return "skipped";
  for (const placedPath of placement.placedPaths) logger.success(`Saved: ${placedPath}`);
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
