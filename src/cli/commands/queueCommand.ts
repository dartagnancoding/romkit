/**
 * romkit queue                         list the queue (with how much of each unfinished download is on disk)
 * romkit queue add <title> -sys <x>    search now, pick the version now, download later
 * romkit queue run                     download everything, `download.parallel` games at a time
 * romkit queue remove <n...|all>       drop items (and their partial files)
 *
 * `queue run` never stops to ask: downloads run side by side, then each file is
 * organized one at a time. A file that needs a decision (which ROM to keep, an
 * uncertain name, a name clash) is moved to <inbox>\<system id>\ for `romkit inbox`.
 */

import { rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { resolveSystemFromFlagOrPrompt } from "../../config/systemResolver";
import type { ResolvedConfig, ResolvedSystem } from "../../config/configTypes";
import { resolveDownloader, type Downloader } from "../../download/aria2c";
import { describePartial, partialDirectoryFor } from "../../download/downloader";
import { createWorkspace, type Workspace } from "../../download/tempWorkspace";
import { RomkitError, UsageError } from "../../errors";
import { ensureSevenZipAvailable } from "../../extraction/sevenZip";
import { logger } from "../../logging/logger";
import { DownloadQueue, type QueueItem } from "../../queue/downloadQueue";
import { HttpClient } from "../../sources/httpClient";
import { ListPageCache } from "../../sources/listPageCache";
import { createSourceAdapter } from "../../sources/sourceRegistry";
import { ensureDirectory, pathExists, transferFile } from "../../util/fileSystem";
import { formatBytes, formatPercent, renderTable } from "../../util/format";
import { acquireResult, describeResult, partialRootOf, searchAndChoose } from "../../workflow/gameDownload";
import { processAcquiredFile } from "../../workflow/processAcquiredFile";
import type { CommandContext } from "../commandContext";
import { statusLine, type ProgressSnapshot } from "../progressBar";
import { style } from "../terminalStyle";
import { NeedsDecisionError, UnattendedPrompter } from "../unattendedPrompter";

export async function runQueueCommand(context: CommandContext): Promise<void> {
  const subcommand = context.args.positionals[1]?.toLowerCase();
  const queue = DownloadQueue.besideConfig(context.config.configPath);
  switch (subcommand) {
    case undefined:
    case "list":
      await listQueue(queue, context.config);
      return;
    case "add":
      await addToQueue(context, queue);
      return;
    case "run":
      await runQueue(context, queue);
      return;
    case "remove":
      await removeFromQueue(context, queue);
      return;
    default:
      throw new UsageError(`Unknown subcommand "queue ${subcommand}".`, "Use: romkit queue [list | add <title> -sys <system> | run | remove <n|all>]");
  }
}

async function listQueue(queue: DownloadQueue, config: ResolvedConfig): Promise<void> {
  const items = await queue.list();
  if (items.length === 0) {
    logger.info(`The queue is empty. Add games with ${style.cyan("romkit queue add <title> -sys <system>")}.`);
    return;
  }
  const rows: string[][] = [];
  for (const [index, item] of items.entries()) {
    rows.push([style.cyan(String(index + 1).padStart(2)), style.bold(item.systemId), describeResult(item.result), await describeState(item, config)]);
  }
  logger.info(renderTable(rows));
  // Below the table, so a long message does not stretch its columns.
  for (const [index, item] of items.entries()) {
    if (item.lastError) logger.info(style.dim(`  ${index + 1}: last try: ${item.lastError}`));
  }
  logger.info(style.dim(`\n${items.length} item(s). Download them with: romkit queue run`));
}

async function describeState(item: QueueItem, config: ResolvedConfig): Promise<string> {
  if (item.status === "pending" || !item.downloadUrl) return style.dim("waiting");
  const partial = await describePartial(partialRootOf(config), item.downloadUrl);
  if (!partial || partial.savedBytes === 0) return style.yellow("unfinished");
  const progress = partial.expectedBytes ? ` ${formatPercent(partial.savedBytes / partial.expectedBytes)}` : "";
  return style.yellow(`unfinished${progress} (${formatBytes(partial.savedBytes)} saved)`);
}

async function addToQueue(context: CommandContext, queue: DownloadQueue): Promise<void> {
  const { args, config, prompter } = context;
  const typedQuery = args.positionals.slice(2).join(" ").trim();
  if (typedQuery === "") throw new UsageError("Missing the title to search for.", "Usage: romkit queue add <title> [-sys <system>]");

  const system = await resolveSystemFromFlagOrPrompt(config, args.flags.system, prompter);
  const httpClient = new HttpClient(config.http);
  const listCache = new ListPageCache(join(config.tempDirectory, "list-cache"), args.flags.refresh ? 0 : undefined);
  const chosen = await searchAndChoose({ config, system, httpClient, listCache, prompter, flags: args.flags }, typedQuery, "Add it to the queue?");
  if (!chosen) return;

  const { alreadyQueued } = await queue.add({ systemId: system.id, query: chosen.query, result: chosen.result, status: "pending" });
  const count = (await queue.list()).length;
  if (alreadyQueued) logger.info(`Already in the queue: ${chosen.result.title}`);
  else logger.success(`Queued (${count} in the queue): ${chosen.result.title}`);
  logger.info(style.dim("Download everything with: romkit queue run"));
}

async function removeFromQueue(context: CommandContext, queue: DownloadQueue): Promise<void> {
  const items = await queue.list();
  const selectors = context.args.positionals.slice(2).map((word) => word.toLowerCase());
  if (selectors.length === 0) throw new UsageError("Which items?", "Usage: romkit queue remove <number...> or romkit queue remove all");

  let chosen: QueueItem[];
  if (selectors.includes("all")) {
    chosen = items;
  } else {
    chosen = selectors.map((selector) => {
      const item = items[Number.parseInt(selector, 10) - 1];
      if (!item || String(Number.parseInt(selector, 10)) !== selector) throw new UsageError(`There is no item ${selector} (the queue has ${items.length}).`);
      return item;
    });
  }
  for (const item of chosen) {
    if (item.downloadUrl) await rm(partialDirectoryFor(partialRootOf(context.config), item.downloadUrl), { recursive: true, force: true });
  }
  await queue.remove(chosen.map((item) => item.id));
  logger.success(`Removed ${chosen.length} item(s) and their unfinished files.`);
}

interface RunTotals {
  saved: number;
  toInbox: number;
  failed: number;
}

async function runQueue(context: CommandContext, queue: DownloadQueue): Promise<void> {
  const { args, config } = context;
  const items = await queue.list();
  if (items.length === 0) {
    logger.info("The queue is empty.");
    return;
  }
  await ensureSevenZipAvailable(config.sevenZipPath);
  const downloader = resolveDownloader(config.download);
  const httpClient = new HttpClient(config.http);
  const listCache = new ListPageCache(join(config.tempDirectory, "list-cache"), args.flags.refresh ? 0 : undefined);
  const parallel = Math.min(config.download.parallel, items.length);
  logger.info(`Downloading ${items.length} item(s), ${parallel} at a time${downloader.kind === "aria2c" ? ` with aria2c` : ""}. Ctrl+C pauses; \`romkit queue run\` continues.\n`);

  const progress = new QueueProgress();
  const totals: RunTotals = { saved: 0, toInbox: 0, failed: 0 };
  // Downloads run side by side; organizing (7-Zip, moving into the library) one at a time.
  let organizing: Promise<unknown> = Promise.resolve();
  const organizeInTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = organizing.then(work);
    organizing = turn.catch(() => {});
    return turn;
  };

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const position = nextIndex++;
      await runItem(items[position]!, `${position + 1}/${items.length}`, { context, queue, downloader, httpClient, listCache, progress, totals, organizeInTurn });
    }
  };
  try {
    await Promise.all(Array.from({ length: parallel }, worker));
  } finally {
    statusLine.clear();
  }

  const parts = [`${totals.saved} saved`];
  if (totals.toInbox > 0) parts.push(`${totals.toInbox} moved to the inbox (run ${style.cyan("romkit inbox")})`);
  if (totals.failed > 0) parts.push(`${totals.failed} failed (still in the queue)`);
  logger.info(`\nDone: ${parts.join(", ")}.`);
  if (totals.failed > 0) process.exitCode = 1;
}

interface RunDependencies {
  context: CommandContext;
  queue: DownloadQueue;
  downloader: Downloader;
  httpClient: HttpClient;
  listCache: ListPageCache;
  progress: QueueProgress;
  totals: RunTotals;
  organizeInTurn: <T>(work: () => Promise<T>) => Promise<T>;
}

async function runItem(item: QueueItem, positionText: string, dependencies: RunDependencies): Promise<void> {
  const { context, queue, totals, progress } = dependencies;
  const { config } = context;
  const title = item.result.title;
  const fail = async (message: string) => {
    totals.failed++;
    logger.error(`✗ [${positionText}] ${title}: ${message}`);
    await queue.patch(item.id, { lastError: message });
  };

  const system = config.systems.find((candidate) => candidate.id.toLowerCase() === item.systemId.toLowerCase());
  if (!system) return fail(`system ${item.systemId} is no longer configured`);
  const sourceConfig = config.sources.find((source) => source.name.toLowerCase() === item.result.sourceName.toLowerCase());
  if (!sourceConfig) return fail(`source "${item.result.sourceName}" is no longer configured`);

  const adapter = createSourceAdapter(sourceConfig, { httpClient: dependencies.httpClient, system, listCache: dependencies.listCache });
  const workspace = await createWorkspace(config.tempDirectory);
  logger.info(`▶ [${positionText}] ${title} ${style.dim(`(${system.id})`)}`);
  try {
    const acquired = await acquireResult({
      config,
      system,
      httpClient: dependencies.httpClient,
      downloader: dependencies.downloader,
      adapter,
      result: item.result,
      query: item.query,
      workspace,
      queue,
      queueItemId: item.id,
      onProgress: (snapshot) => progress.update(item.id, title, snapshot),
      reportBlockedPages: false,
    });
    progress.remove(item.id);
    if (acquired.kind === "blocked") {
      return fail(`the site blocked the download (${acquired.outcome.detail}). Open ${acquired.outcome.pageUrl} to get it manually.`);
    }
    await dependencies.organizeInTurn(() => organize(acquired.filePath, item, system, workspace, positionText, dependencies));
  } catch (error) {
    progress.remove(item.id);
    if (!(error instanceof RomkitError)) throw error;
    // The hint of a download error says to rerun the command; in the queue, `romkit queue run` does that.
    await fail(error.message);
  } finally {
    await workspace.dispose(context.args.flags.keepTemp);
  }
}

/** Places the file without asking anything; when a decision is needed, hands the file to the inbox instead. */
async function organize(
  filePath: string,
  item: QueueItem,
  system: ResolvedSystem,
  workspace: Workspace,
  positionText: string,
  dependencies: RunDependencies,
): Promise<void> {
  const { context, totals } = dependencies;
  const title = item.result.title;
  try {
    const outcome = await processAcquiredFile(filePath, {
      system,
      config: context.config,
      prompter: new UnattendedPrompter(),
      flags: { ...context.args.flags, yes: false },
      workspace,
      hints: [title, item.query],
      removeSourceWhenDone: true,
    });
    totals.saved++;
    logger.success(`✔ [${positionText}] ${title}${outcome === "duplicate" ? style.dim(" (an equal or better copy was already there; this one went to _duplicates)") : ""}`);
  } catch (error) {
    if (!(error instanceof RomkitError)) throw error;
    const reason = error instanceof NeedsDecisionError ? error.question : error.message;
    const inboxPath = await moveToInbox(filePath, system, context.config);
    totals.toInbox++;
    logger.warn(`↪ [${positionText}] ${title}: ${reason}`);
    logger.warn(`   Moved to ${inboxPath}; ${style.cyan("romkit inbox")} will ask you.`);
  }
}

/** <inbox>\<system id>\<file>: the folder name tells `romkit inbox` which console it is. */
async function moveToInbox(filePath: string, system: ResolvedSystem, config: ResolvedConfig): Promise<string> {
  const folder = join(config.inboxDirectory, system.id);
  await ensureDirectory(folder);
  const extension = extname(filePath);
  const stem = basename(filePath, extension);
  let targetPath = join(folder, basename(filePath));
  for (let copyNumber = 2; await pathExists(targetPath); copyNumber++) targetPath = join(folder, `${stem} (${copyNumber})${extension}`);
  await transferFile(filePath, targetPath, "move");
  return targetPath;
}

/** One status line for every download in progress: "⬇ Crash Bandicoot 2 45% 6.1 MB/s · Spider-Man 80% 3.0 MB/s". */
class QueueProgress {
  private readonly entries = new Map<string, { title: string; snapshot: ProgressSnapshot }>();
  private lastDraw = 0;

  update(id: string, title: string, snapshot: ProgressSnapshot): void {
    this.entries.set(id, { title, snapshot });
    const now = Date.now();
    if (now - this.lastDraw >= 200) {
      this.lastDraw = now;
      this.draw();
    }
  }

  remove(id: string): void {
    this.entries.delete(id);
    this.draw();
  }

  private draw(): void {
    if (this.entries.size === 0) {
      statusLine.clear();
      return;
    }
    const width = Math.max(12, Math.floor(40 / this.entries.size));
    const parts = [...this.entries.values()].map(({ title, snapshot }) => {
      const shortTitle = title.length > width ? `${title.slice(0, width - 1)}…` : title;
      const percent = snapshot.totalBytes ? formatPercent(snapshot.transferredBytes / snapshot.totalBytes) : formatBytes(snapshot.transferredBytes);
      return `${shortTitle} ${percent} ${style.dim(`${formatBytes(snapshot.bytesPerSecond)}/s`)}`;
    });
    statusLine.update(`⬇ ${parts.join("  ·  ")}`);
  }
}
