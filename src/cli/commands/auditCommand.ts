/**
 * romkit audit [folder] [-sys <system>]
 *
 * Read-only report; nothing is changed.
 *   romkit audit                      every configured system folder
 *   romkit audit -sys ps2             one system folder
 *   romkit audit "E:\old\PS2" -sys ps2  any folder, judged by that system's rules
 */

import { basename, resolve } from "node:path";
import type { ResolvedConfig, ResolvedSystem } from "../../config/configTypes";
import { findSystem, requireSystem } from "../../config/systemResolver";
import { RomkitError, UsageError } from "../../errors";
import { logger } from "../../logging/logger";
import { auditArcadeFolder, auditFolder, type AuditReport } from "../../organization/libraryAudit";
import { DUPLICATES_FOLDER_NAME } from "../../organization/libraryOrganizer";
import { isDirectory } from "../../util/fileSystem";
import { renderTable } from "../../util/format";
import type { CommandContext } from "../commandContext";
import { style } from "../terminalStyle";

/** Long lists are cut unless --verbose is used. */
const MAX_LISTED_PER_SECTION = 25;

export async function runAuditCommand(context: CommandContext): Promise<void> {
  const { args, config } = context;
  const typedFolder = args.positionals.slice(1).join(" ").trim();

  if (typedFolder) {
    const folderPath = resolve(typedFolder);
    if (!(await isDirectory(folderPath))) throw new RomkitError(`Folder not found: ${folderPath}`);
    // The folder name may already say which system it is ("...\PS2").
    const system = args.flags.system ? requireSystem(config, args.flags.system) : findSystem(config, basename(folderPath));
    if (!system) throw new UsageError(`Which system is ${folderPath}?`, `Add -sys, e.g.: romkit audit "${typedFolder}" -sys ps2`);
    await auditAndPrint(system, folderPath, config, false);
    return;
  }

  const systems = args.flags.system ? [requireSystem(config, args.flags.system)] : config.systems;
  for (const system of systems) {
    if (!(await isDirectory(system.folderPath))) {
      logger.info(style.dim(`${system.name}: folder not created yet (${system.folderPath})\n`));
      continue;
    }
    await auditAndPrint(system, system.folderPath, config, true);
  }
}

async function auditAndPrint(system: ResolvedSystem, folderPath: string, config: ResolvedConfig, isLibraryFolder: boolean): Promise<void> {
  if (system.mode === "arcade") {
    const arcadeAudit = await auditArcadeFolder(system, folderPath);
    logger.info(style.bold(`${system.name}`) + style.dim(`  ${folderPath}`));
    logger.info(`  ${arcadeAudit.romsetCount} romset(s). Arcade romsets keep their names; check them with your emulator's audit (e.g. MAME -verifyroms).`);
    printOtherFiles(arcadeAudit.otherFiles);
    logger.info("");
    return;
  }

  const report = await auditFolder(system, folderPath, config);
  printReport(report, config, isLibraryFolder);
}

function printReport(report: AuditReport, config: ResolvedConfig, isLibraryFolder: boolean): void {
  const { system } = report;
  const verifiedCount = report.roms.filter((rom) => rom.verified === true).length;
  const datText = report.hasDat ? `${verifiedCount}/${report.roms.length} verified by DAT` : "no DAT (names come from file names)";
  logger.info(style.bold(`${system.name}`) + style.dim(`  ${report.folderPath}`));
  logger.info(`  ${report.roms.length} game(s), ${datText}`);

  const setAsideCount = report.duplicateGroups.reduce((sum, group) => sum + group.setAside.length, 0);
  const nothingToDo = setAsideCount === 0 && report.renames.length === 0 && report.unverified.length === 0 && report.otherFiles.length === 0;
  if (nothingToDo) {
    logger.success("  All good.\n");
    return;
  }

  if (report.duplicateGroups.length > 0) {
    logger.info(style.yellow(`\n  Duplicates: ${report.duplicateGroups.length} game(s) with more than one copy`));
    for (const group of limit(report.duplicateGroups)) {
      logger.info(`    ${style.green("keep")}      ${group.keeper.fileName}`);
      for (const entry of group.setAside) {
        logger.info(`    ${style.yellow("set aside")} ${entry.rom.fileName}  ${style.dim(`(${entry.reason})`)}`);
      }
    }
    printCut(report.duplicateGroups.length);
  }

  if (report.renames.length > 0) {
    logger.info(style.yellow(`\n  Names to standardize: ${report.renames.length}`));
    const rows = limit(report.renames).map((rom) => {
      const lowConfidence = rom.identification.confidence < config.autoAcceptThreshold;
      return [`  ${rom.fileName}`, style.dim("→"), style.cyan(rom.suggestedFileName), lowConfidence ? style.yellow("? will ask") : ""];
    });
    logger.info(renderTable(rows, "  "));
    printCut(report.renames.length);
  }

  if (report.unverified.length > 0) {
    logger.info(style.yellow(`\n  Not in the DAT: ${report.unverified.length} (hack, translation, bad/modified dump, or not covered)`));
    for (const rom of limit(report.unverified)) logger.info(`    ${rom.fileName}`);
    printCut(report.unverified.length);
  }

  printOtherFiles(report.otherFiles);

  // What to run next. organize only works on the library folder of the system.
  if (setAsideCount > 0 || report.renames.length > 0) {
    if (isLibraryFolder) {
      logger.info(
        style.dim(`\n  Fix: romkit organize -sys ${system.id}  (renames, and moves the set-aside copies to ${DUPLICATES_FOLDER_NAME})`),
      );
    } else {
      logger.info(style.dim(`\n  Fix: romkit inbox "${report.folderPath}" -sys ${system.id} --keep-source  (copies the best versions into the library)`));
    }
  }
  logger.info("");
}

function printOtherFiles(otherFiles: string[]): void {
  if (otherFiles.length === 0) return;
  logger.info(style.yellow(`\n  Other files in the folder: ${otherFiles.length}`) + style.dim(" (not games for this system; never touched)"));
  for (const fileName of limit(otherFiles)) logger.info(`    ${fileName}`);
  printCut(otherFiles.length);
}

/** With --verbose every item is listed. */
function limit<Item>(items: Item[]): Item[] {
  return logger.isVerbose ? items : items.slice(0, MAX_LISTED_PER_SECTION);
}

function printCut(totalCount: number): void {
  if (!logger.isVerbose && totalCount > MAX_LISTED_PER_SECTION) {
    logger.info(style.dim(`    ... and ${totalCount - MAX_LISTED_PER_SECTION} more (run with --verbose to list all)`));
  }
}
