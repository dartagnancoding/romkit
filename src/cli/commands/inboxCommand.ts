/**
 * romkit inbox [folder] [--dry-run] [--yes] [--keep-source] [-sys <system>]
 *
 * Processes everything dropped into the inbox folder (default
 * %USERPROFILE%\Downloads\dump): figures out each file's console, then runs the
 * same extract → identify → rename → organize flow as `import`.
 *
 * Successfully organized files leave the inbox (unless --keep-source); files that
 * fail or are not recognized stay there, with the reason in the summary.
 */

import { readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ResolvedConfig, ResolvedSystem } from "../../config/configTypes";
import { findSystem, requireSystem } from "../../config/systemResolver";
import { createWorkspace } from "../../download/tempWorkspace";
import { RomkitError, UserCancelledError } from "../../errors";
import { ensureSevenZipAvailable } from "../../extraction/sevenZip";
import { detectSystemsForFile, type SystemDetection } from "../../inbox/systemDetector";
import { scanInbox, type InboxItem } from "../../inbox/inboxScanner";
import { logger } from "../../logging/logger";
import { ensureDirectory, isDirectory, pathExists } from "../../util/fileSystem";
import { renderTable } from "../../util/format";
import { processAcquiredFile } from "../../workflow/processAcquiredFile";
import type { CommandContext } from "../commandContext";
import type { Prompter } from "../prompts";
import { style } from "../terminalStyle";

interface ItemOutcome {
  item: InboxItem;
  status: "placed" | "duplicate" | "skipped" | "failed" | "unrecognized";
  detail: string;
}

export async function runInboxCommand(context: CommandContext): Promise<void> {
  const { args, config, prompter } = context;
  const typedFolder = args.positionals.slice(1).join(" ").trim();
  const inboxRoot = typedFolder ? resolve(typedFolder) : config.inboxDirectory;

  if (!(await isDirectory(inboxRoot))) {
    if (typedFolder) throw new RomkitError(`Folder not found: ${inboxRoot}`);
    // First run with the default folder: create it so the user knows where to drop files.
    await ensureDirectory(inboxRoot);
    logger.info(`Created the inbox folder ${inboxRoot}. Drop your dumps there and run this again.`);
    return;
  }
  await ensureSevenZipAvailable(config.sevenZipPath);
  const forcedSystem = args.flags.system ? requireSystem(config, args.flags.system) : null;

  const scan = await scanInbox(inboxRoot);
  if (scan.items.length === 0) {
    logger.info(`Nothing to organize in ${inboxRoot}.`);
    return;
  }
  logger.info(`Inbox: ${inboxRoot} (${scan.items.length} item(s))\n`);

  // Detect every item first, so --dry-run can show the whole plan.
  const detections = new Map<InboxItem, SystemDetection>();
  for (const item of scan.items) {
    const detection = forcedSystem
      ? { systems: [forcedSystem], reason: "-sys" }
      : await detectSystemsForFile(item.filePath, inboxRoot, config);
    detections.set(item, detection);
  }

  printPlan(scan.items, detections, inboxRoot);
  if (args.flags.dryRun) {
    logger.info(style.dim("\nDry run: nothing was moved."));
    return;
  }
  // Show the plan before touching anything (skipped with --yes, e.g. for scheduled runs).
  if (!args.flags.yes && !(await prompter.confirm(`\nOrganize these ${scan.items.length} item(s)?`, true))) {
    logger.info("Nothing was moved.");
    return;
  }

  const outcomes: ItemOutcome[] = [];
  for (const [itemIndex, item] of scan.items.entries()) {
    const relativeName = relative(inboxRoot, item.filePath);
    logger.info(style.bold(`\n[${itemIndex + 1}/${scan.items.length}] ${relativeName}`));
    const detection = detections.get(item)!;

    const system = await chooseSystem(detection, prompter, args.flags.yes);
    if (!system) {
      const detail = detection.systems.length === 0 ? `console not recognized (${detection.reason})` : "several consoles possible; skipped";
      logger.warn(`  ${detail}`);
      outcomes.push({ item, status: detection.systems.length === 0 ? "unrecognized" : "skipped", detail });
      continue;
    }
    logger.info(style.dim(`  → ${system.name} (${detection.reason})`));

    outcomes.push(await processItem(item, system, inboxRoot, context));
  }

  if (!args.flags.keepSource) await removeEmptyFolders(inboxRoot);
  printSummary(outcomes, scan.looseFiles, inboxRoot);
}

async function processItem(item: InboxItem, system: ResolvedSystem, inboxRoot: string, context: CommandContext): Promise<ItemOutcome> {
  const { config, prompter, args } = context;
  const workspace = await createWorkspace(config.tempDirectory);
  try {
    const outcome = await processAcquiredFile(item.filePath, {
      system,
      config,
      prompter,
      flags: args.flags,
      workspace,
      hints: folderHints(item.filePath, inboxRoot, config),
      removeSourceWhenDone: !args.flags.keepSource,
    });
    const leftTheInbox = outcome === "placed" || outcome === "duplicate";
    if (leftTheInbox && !args.flags.keepSource) {
      // The first volume of a split RAR was deleted by the pipeline; the other parts go too.
      for (const companionPath of item.companionPaths) await unlink(companionPath).catch(() => {});
    }
    return { item, status: outcome, detail: leftTheInbox ? system.name : "skipped" };
  } catch (error) {
    if (error instanceof UserCancelledError) throw error;
    const message = error instanceof RomkitError ? error.message : `unexpected error: ${(error as Error).message}`;
    logger.error(`  ${message}`);
    return { item, status: "failed", detail: message };
  } finally {
    await workspace.dispose(args.flags.keepTemp);
  }
}

/** One system: use it. Several: ask (or skip with --yes). None: null. */
async function chooseSystem(detection: SystemDetection, prompter: Prompter, assumeYes: boolean): Promise<ResolvedSystem | null> {
  if (detection.systems.length === 1) return detection.systems[0]!;
  if (detection.systems.length === 0 || assumeYes) return null;
  const chosenIndex = await prompter.chooseFromList(
    `  Which console is it? (${detection.reason})`,
    detection.systems.map((system) => `${system.name} ${style.dim(`(${system.id})`)}`),
  );
  return chosenIndex === null ? null : detection.systems[chosenIndex]!;
}

/**
 * Folder names between the inbox and the file can describe the game
 * ("Final Fantasy VII (USA)\Disc 1.7z"); names of consoles are not useful hints.
 */
function folderHints(filePath: string, inboxRoot: string, config: ResolvedConfig): string[] {
  const relativeFolder = relative(inboxRoot, dirname(filePath));
  if (relativeFolder === "") return [];
  return relativeFolder
    .split(/[\\/]/)
    .reverse()
    .filter((folderName) => !findSystem(config, folderName) && !folderName.includes(","));
}

function printPlan(items: InboxItem[], detections: Map<InboxItem, SystemDetection>, inboxRoot: string): void {
  const rows = items.map((item) => {
    const detection = detections.get(item)!;
    const target =
      detection.systems.length === 1
        ? style.cyan(detection.systems[0]!.name)
        : detection.systems.length === 0
          ? style.red("not recognized")
          : style.yellow(`ask: ${detection.systems.map((system) => system.id).join(" / ")}`);
    return [relative(inboxRoot, item.filePath), style.dim("→"), target, style.dim(detection.reason)];
  });
  logger.info(renderTable(rows));
}

function printSummary(outcomes: ItemOutcome[], looseFiles: string[], inboxRoot: string): void {
  const count = (status: ItemOutcome["status"]) => outcomes.filter((outcome) => outcome.status === status).length;
  logger.info("");
  logger.success(`Organized: ${count("placed")}`);
  if (count("duplicate") > 0) logger.info(`Duplicates set aside in _duplicates: ${count("duplicate")}`);
  if (count("skipped") > 0) logger.info(`Skipped: ${count("skipped")}`);

  const problems = outcomes.filter((outcome) => outcome.status === "failed" || outcome.status === "unrecognized");
  if (problems.length > 0) {
    logger.warn(`Left in the inbox: ${problems.length}`);
    for (const problem of problems) logger.warn(`  ${relative(inboxRoot, problem.item.filePath)}: ${problem.detail}`);
  }
  if (looseFiles.length > 0) {
    logger.info(style.dim(`Ignored ${looseFiles.length} non-game file(s) (readmes, links, saves...); they stay in the inbox.`));
  }
}

/** Deletes folders left empty after their files were organized (never the inbox itself). */
async function removeEmptyFolders(folderPath: string, isRoot = true): Promise<void> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyFolders(join(folderPath, entry.name), false);
  }
  if (isRoot || !(await pathExists(folderPath))) return;
  if ((await readdir(folderPath)).length === 0) await rmdir(folderPath).catch(() => {});
}
