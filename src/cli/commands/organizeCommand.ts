/**
 * romkit organize -sys <system> [--dry-run] [--yes]
 *
 * Standardizes the names of the files already in a system's folder:
 *   1. identify every ROM (DAT hash → alias → fuzzy → file name);
 *   2. show the "before → after" plan;
 *   3. stop here with --dry-run; otherwise confirm, then rename one by one,
 *      asking about low-confidence names and name conflicts.
 *
 * Only files directly inside the system folder are considered (no subfolders).
 * Files with other extensions are never touched.
 */

import { basename } from "node:path";
import { resolveSystemFromFlagOrPrompt } from "../../config/systemResolver";
import { RomkitError } from "../../errors";
import { buildRomUnits } from "../../extraction/romUnits";
import { identifyRomUnit, loadIdentificationContext } from "../../identification/romIdentifier";
import { logger } from "../../logging/logger";
import { formatRomBaseName } from "../../naming/nameFormatter";
import { parseRomName } from "../../naming/tagParser";
import { LibraryIndex } from "../../organization/libraryIndex";
import { placeRomUnit } from "../../organization/libraryOrganizer";
import { buildRenamePlan, renderRenamePlan } from "../../organization/renamePlanner";
import { fileStem, isDirectory, listFilesShallow } from "../../util/fileSystem";
import type { CommandContext } from "../commandContext";
import { confirmRomName } from "../nameConfirmation";
import { statusLine } from "../progressBar";
import { style } from "../terminalStyle";

export async function runOrganizeCommand(context: CommandContext): Promise<void> {
  const { args, config, prompter } = context;
  const system = await resolveSystemFromFlagOrPrompt(config, args.flags.system, prompter);

  if (system.mode === "arcade") {
    logger.info(`${system.id} is an arcade system: romsets keep their exact short names, so there is nothing to rename.`);
    return;
  }
  if (!(await isDirectory(system.folderPath))) {
    throw new RomkitError(`The folder for ${system.id} does not exist: ${system.folderPath}`);
  }

  const scan = await buildRomUnits(await listFilesShallow(system.folderPath), system.extensions);
  for (const warning of scan.warnings) logger.warn(warning);
  if (scan.units.length === 0) {
    logger.info(`No ${system.id} ROMs (${system.extensions.join(", ")}) found in ${system.folderPath}.`);
    return;
  }

  const identificationContext = await loadIdentificationContext(system, config);
  // The index remembers each file's original release name, a better hint than the cleaned file name.
  const libraryIndex = await LibraryIndex.load(system.folderPath);
  const identifiedItems = [];
  for (const [unitIndex, unit] of scan.units.entries()) {
    statusLine.update(`Identifying ${unitIndex + 1}/${scan.units.length}: ${basename(unit.primaryFilePath)}`);
    const recordedRelease = libraryIndex.get(basename(unit.primaryFilePath))?.releaseName;
    const identification = await identifyRomUnit(unit, recordedRelease ? [recordedRelease] : [], identificationContext);
    identifiedItems.push({ unit, identification, suggestedBaseName: formatRomBaseName(identification, system.naming, system.id) });
  }
  statusLine.clear();

  const plan = buildRenamePlan(identifiedItems, config.autoAcceptThreshold);
  if (plan.changes.length === 0) {
    logger.success(`All ${plan.unchangedCount} ${system.id} file(s) already follow the naming standard.`);
    return;
  }

  logger.info(`Planned changes in ${system.folderPath}:`);
  logger.info(renderRenamePlan(plan));
  const confirmationCount = plan.changes.filter((change) => change.needsConfirmation).length;
  logger.info(
    `\n${plan.changes.length} to rename, ${plan.unchangedCount} already standardized` +
      (confirmationCount > 0 ? `, ${confirmationCount} with low confidence (marked "?")` : "") +
      ".",
  );

  if (args.flags.dryRun) {
    logger.info(style.dim("Dry run: nothing was changed."));
    return;
  }
  if (!args.flags.yes && !(await prompter.confirm("Apply these changes?", false))) {
    logger.info("Nothing was changed.");
    return;
  }

  let renamedCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  for (const change of plan.changes) {
    const currentFileName = basename(change.unit.primaryFilePath);
    // What this file really is: the recorded release, or its own name while it still has tags.
    const releaseName = libraryIndex.get(currentFileName)?.releaseName ?? fileStem(change.unit.primaryFilePath);

    // High-confidence names pass straight through; low-confidence ones are asked here.
    const baseName = await confirmRomName(change.identification, system, prompter, {
      originalName: basename(change.unit.primaryFilePath),
      autoAcceptThreshold: config.autoAcceptThreshold,
      assumeYes: args.flags.yes,
    });
    if (baseName === null || baseName === fileStem(change.unit.primaryFilePath)) {
      skippedCount++;
      continue;
    }

    const placement = await placeRomUnit(
      {
        unit: change.unit,
        targetDirectory: system.folderPath,
        baseName,
        transfer: "move",
        // organize only renames; it never converts files to zip.
        compressToZip: false,
        sevenZipPath: config.sevenZipPath,
        stagingDirectory: config.tempDirectory,
        assumeYes: args.flags.yes,
        // Two files becoming the same name are two versions of one game: keep the better one.
        // The organizer also moves this file's index record to its new name.
        release: { name: releaseName, tags: parseRomName(releaseName).tags },
        preferences: system.preferences,
      },
      prompter,
    );
    if (placement.status === "placed") {
      renamedCount++;
      logger.debug(`Renamed ${currentFileName} → ${basename(placement.placedPaths[0]!)}`);
    } else if (placement.status === "duplicate") {
      duplicateCount++;
    } else {
      skippedCount++;
    }
  }

  const duplicateText = duplicateCount > 0 ? `, ${duplicateCount} set aside in _duplicates` : "";
  logger.success(`Done: ${renamedCount} renamed${duplicateText}, ${skippedCount} skipped.`);
}
