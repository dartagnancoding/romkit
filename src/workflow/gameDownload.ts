/**
 * The steps `romkit download` and the queue share: search a system's sources and
 * let the user pick a result; then download a picked result into a job folder,
 * keeping it in the queue file until every byte is on disk, so an interrupted
 * download shows up in `romkit queue` and continues from there.
 */

import { join } from "node:path";
import type { ParsedFlags } from "../cli/argumentParser";
import { reportBlocked } from "../cli/blockedReport";
import type { ProgressListener } from "../cli/progressBar";
import type { Prompter } from "../cli/prompts";
import { style } from "../cli/terminalStyle";
import type { ResolvedConfig, ResolvedSystem, SourceConfig } from "../config/configTypes";
import type { Downloader } from "../download/aria2c";
import { downloadFile } from "../download/downloader";
import type { Workspace } from "../download/tempWorkspace";
import { RomkitError } from "../errors";
import { AliasTable } from "../identification/aliasTable";
import { logger } from "../logging/logger";
import { sanitizeFileName } from "../naming/filenameSanitizer";
import type { DownloadQueue } from "../queue/downloadQueue";
import type { HttpClient } from "../sources/httpClient";
import type { ListPageCache } from "../sources/listPageCache";
import { buildSearchUrl, type BlockedOutcome, type SearchResult, type SourceAdapter } from "../sources/sourceAdapter";
import { sortByRelevance } from "../sources/selectorSource";
import { createSourceAdapter } from "../sources/sourceRegistry";

export interface SearchContext {
  config: ResolvedConfig;
  system: ResolvedSystem;
  httpClient: HttpClient;
  listCache: ListPageCache;
  prompter: Prompter;
  flags: ParsedFlags;
}

export interface ChosenGame {
  /** The title actually searched (after the alias table). */
  query: string;
  result: SearchResult;
  adapter: SourceAdapter;
}

/** Searches every source of the system and asks which result to take; null when cancelled or nothing was found. */
export async function searchAndChoose(context: SearchContext, typedQuery: string, confirmQuestion: string): Promise<ChosenGame | null> {
  const { config, system, httpClient, listCache, prompter, flags } = context;

  const aliasTable = await AliasTable.load(config.aliasesFilePath);
  const aliasTitle = aliasTable.lookup(system.id, typedQuery);
  const query = aliasTitle ?? typedQuery;
  if (aliasTitle) logger.info(`Alias: "${typedQuery}" → "${aliasTitle}"`);

  const allResults: SearchResult[] = [];
  const adapterBySourceName = new Map<string, SourceAdapter>();
  const browserOnlySources: { name: string; url: string }[] = [];

  for (const sourceConfig of selectSources(config, system, flags.source)) {
    if (sourceConfig.requiresJavaScript) {
      browserOnlySources.push({ name: sourceConfig.name, url: buildSearchUrl(sourceConfig, system, query) });
      continue;
    }
    const adapter = createSourceAdapter(sourceConfig, { httpClient, system, listCache });
    logger.info(`Searching ${sourceConfig.name} for "${query}"...`);
    const outcome = await adapter.search(query);
    if (outcome.kind === "blocked") {
      reportBlocked(sourceConfig.name, outcome, system);
      return null;
    }
    logger.debug(`${sourceConfig.name}: ${outcome.results.length} result(s)`);
    allResults.push(...outcome.results);
    adapterBySourceName.set(sourceConfig.name, adapter);
  }

  if (browserOnlySources.length > 0) {
    logger.info(style.dim("These sources need a browser (JavaScript) and are not searched automatically:"));
    for (const browserOnlySource of browserOnlySources) {
      logger.info(style.dim(`  ${browserOnlySource.name}: ${browserOnlySource.url}`));
    }
  }

  if (allResults.length === 0) {
    const searchedNames = [...adapterBySourceName.keys()];
    logger.warn(
      searchedNames.length > 0 ? `No results for "${query}" in ${searchedNames.join(", ")}.` : `No source was searched automatically for ${system.id}.`,
    );
    process.exitCode = 1;
    return null;
  }

  const rankedResults = adapterBySourceName.size > 1 ? sortByRelevance(allResults, query, system.preferences) : allResults;
  const result = await chooseResult(rankedResults, prompter, flags.yes, confirmQuestion);
  if (!result) {
    logger.info("Cancelled.");
    return null;
  }
  return { query, result, adapter: adapterBySourceName.get(result.sourceName)! };
}

/** The system's sources in configured order, optionally narrowed by --source. */
export function selectSources(config: ResolvedConfig, system: ResolvedSystem, sourceFilter: string | undefined): SourceConfig[] {
  const sourceByLowerName = new Map(config.sources.map((source) => [source.name.toLowerCase(), source]));
  const systemSources = system.sourceNames
    .map((sourceName) => sourceByLowerName.get(sourceName.toLowerCase()))
    .filter((source): source is SourceConfig => source !== undefined);

  if (systemSources.length === 0) {
    throw new RomkitError(
      `System ${system.id} has no sources configured.`,
      `Import some with \`romkit sources import <file or link>\`, or add "systems": ["${system.id}"] to a source in ${config.configPath}. ` +
        "You can also download manually and use `romkit import`.",
    );
  }
  if (!sourceFilter) return systemSources;

  const filteredSources = systemSources.filter((source) => source.name.toLowerCase() === sourceFilter.toLowerCase());
  if (filteredSources.length === 0) {
    throw new RomkitError(`Source "${sourceFilter}" is not configured for ${system.id}. Available: ${systemSources.map((source) => source.name).join(", ")}.`);
  }
  return filteredSources;
}

/** "USA/Mega Man 3 (U) [!]  384 KB  — NES Mega Pack" */
export function describeResult(result: SearchResult): string {
  // Show tags only when they are not already part of the visible title.
  const extraTags = result.regionTags.filter((tag) => !result.title.includes(tag));
  const tagText = extraTags.length > 0 ? style.yellow(`[${extraTags.join(", ")}]`) : "";
  const folderText = result.folder ? style.dim(`${result.folder}/`) : "";
  const sizeText = result.sizeText ? style.dim(result.sizeText) : "";
  return [folderText + result.title, tagText, sizeText, style.dim(`— ${result.sourceName}`)].filter(Boolean).join("  ");
}

async function chooseResult(results: SearchResult[], prompter: Prompter, assumeYes: boolean, confirmQuestion: string): Promise<SearchResult | null> {
  const labels = results.map(describeResult);
  if (results.length === 1) {
    logger.info(`Found: ${labels[0]}`);
    if (assumeYes) return results[0]!;
    return (await prompter.confirm(confirmQuestion, true)) ? results[0]! : null;
  }
  const chosenIndex = await prompter.chooseFromList(`Found ${results.length} results:`, labels);
  return chosenIndex === null ? null : results[chosenIndex]!;
}

export interface AcquireRequest {
  config: ResolvedConfig;
  system: ResolvedSystem;
  httpClient: HttpClient;
  downloader: Downloader;
  adapter: SourceAdapter;
  result: SearchResult;
  query: string;
  workspace: Workspace;
  queue: DownloadQueue;
  /** The queue item being run; without it, an "unfinished" item is created for the time the transfer takes. */
  queueItemId?: string;
  onProgress?: ProgressListener;
  /** false: blocked pages are returned without being printed (the queue reports them its own way). */
  reportBlockedPages?: boolean;
}

export type AcquireOutcome = { kind: "downloaded"; filePath: string } | { kind: "blocked"; outcome: BlockedOutcome };

/**
 * Resolves the result's download URL and downloads it into the job folder.
 * The queue item stays until every byte is on disk, so an interruption is visible
 * in `romkit queue`; it is removed as soon as the file is complete.
 */
export async function acquireResult(request: AcquireRequest): Promise<AcquireOutcome> {
  const { config, system, result, queue } = request;
  const blocked = (outcome: BlockedOutcome): AcquireOutcome => {
    if (request.reportBlockedPages !== false) reportBlocked(result.sourceName, outcome, system);
    return { kind: "blocked", outcome };
  };

  const resolution = await request.adapter.resolveDownload(result);
  if (resolution.kind === "blocked") return blocked(resolution);

  let queueItemId = request.queueItemId;
  const createdHere = queueItemId === undefined;
  if (queueItemId === undefined) {
    const added = await queue.add({ systemId: system.id, query: request.query, result, status: "unfinished", downloadUrl: resolution.downloadUrl });
    queueItemId = added.item.id;
  }
  await queue.patch(queueItemId, { status: "unfinished", downloadUrl: resolution.downloadUrl, lastError: undefined });

  try {
    const download = await downloadFile(
      {
        url: resolution.downloadUrl,
        referer: resolution.referer,
        pageUrl: result.pageUrl,
        destinationDirectory: request.workspace.downloadDirectory,
        fallbackFileName: resolution.suggestedFileName ?? `${sanitizeFileName(result.title)}.download`,
        partialRoot: partialRootOf(config),
        onProgress: request.onProgress,
      },
      request.httpClient,
      request.downloader,
    );
    if (download.kind === "blocked") {
      // Nothing was saved: a one-off download leaves no trace; a queued one keeps the reason.
      if (createdHere) await queue.remove([queueItemId]);
      else await queue.patch(queueItemId, { lastError: `blocked: ${download.detail}` });
      return blocked(download);
    }
    await queue.remove([queueItemId]);
    return { kind: "downloaded", filePath: download.filePath };
  } catch (error) {
    await queue.patch(queueItemId, { lastError: (error as Error).message });
    throw error;
  }
}

export function partialRootOf(config: ResolvedConfig): string {
  return join(config.tempDirectory, "partial");
}
