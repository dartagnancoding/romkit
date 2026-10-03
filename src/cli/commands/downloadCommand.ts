/**
 * romkit download <title> [-sys <system>] [--source <name>]
 *
 * Searches the system's sources in order, lets the user pick a result, downloads
 * it to a temp folder and hands it to the shared extract/identify/organize pipeline.
 */

import { join } from "node:path";
import type { ResolvedConfig, ResolvedSystem, SourceConfig } from "../../config/configTypes";
import { resolveSystemFromFlagOrPrompt } from "../../config/systemResolver";
import { downloadFile } from "../../download/downloader";
import { createWorkspace } from "../../download/tempWorkspace";
import { RomkitError, UsageError } from "../../errors";
import { ensureSevenZipAvailable } from "../../extraction/sevenZip";
import { AliasTable } from "../../identification/aliasTable";
import { logger } from "../../logging/logger";
import { sanitizeFileName } from "../../naming/filenameSanitizer";
import { HttpClient } from "../../sources/httpClient";
import { ListPageCache } from "../../sources/listPageCache";
import { buildSearchUrl, type SearchResult, type SourceAdapter } from "../../sources/sourceAdapter";
import { createSourceAdapter } from "../../sources/sourceRegistry";
import { processAcquiredFile } from "../../workflow/processAcquiredFile";
import { reportBlocked } from "../blockedReport";
import type { CommandContext } from "../commandContext";
import type { Prompter } from "../prompts";
import { style } from "../terminalStyle";

export async function runDownloadCommand(context: CommandContext): Promise<void> {
  const { args, config, prompter } = context;

  // Words after "download" form the title, so quotes are optional: romkit download mega man zero 4
  const typedQuery = args.positionals.slice(1).join(" ").trim();
  if (typedQuery === "") {
    throw new UsageError("Missing the title to search for.", "Usage: romkit download <title> [-sys <system>]");
  }

  const system = await resolveSystemFromFlagOrPrompt(config, args.flags.system, prompter);
  // Fail before downloading anything if 7-Zip is missing.
  await ensureSevenZipAvailable(config.sevenZipPath);

  const aliasTable = await AliasTable.load(config.aliasesFilePath);
  const aliasTitle = aliasTable.lookup(system.id, typedQuery);
  const query = aliasTitle ?? typedQuery;
  if (aliasTitle) logger.info(`Alias: "${typedQuery}" → "${aliasTitle}"`);

  const sources = selectSources(config, system, args.flags.source);
  const httpClient = new HttpClient(config.http);
  // --refresh skips reading the cache but still saves the fresh copies.
  const listCache = new ListPageCache(join(config.tempDirectory, "list-cache"), args.flags.refresh ? 0 : undefined);

  const allResults: SearchResult[] = [];
  const adapterBySourceName = new Map<string, SourceAdapter>();
  const browserOnlySources: { name: string; url: string }[] = [];

  for (const sourceConfig of sources) {
    if (sourceConfig.requiresJavaScript) {
      browserOnlySources.push({ name: sourceConfig.name, url: buildSearchUrl(sourceConfig, system, query) });
      continue;
    }
    const adapter = createSourceAdapter(sourceConfig, { httpClient, system, listCache });
    logger.info(`Searching ${sourceConfig.name} for "${query}"...`);
    const outcome = await adapter.search(query);
    if (outcome.kind === "blocked") {
      reportBlocked(sourceConfig.name, outcome, system);
      return;
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
      searchedNames.length > 0
        ? `No results for "${query}" in ${searchedNames.join(", ")}.`
        : `No source was searched automatically for ${system.id}.`,
    );
    process.exitCode = 1;
    return;
  }

  const chosenResult = await chooseResult(allResults, prompter, args.flags.yes);
  if (!chosenResult) {
    logger.info("Cancelled.");
    return;
  }

  const adapter = adapterBySourceName.get(chosenResult.sourceName)!;
  const resolution = await adapter.resolveDownload(chosenResult);
  if (resolution.kind === "blocked") {
    reportBlocked(chosenResult.sourceName, resolution, system);
    return;
  }

  const workspace = await createWorkspace(config.tempDirectory);
  try {
    const download = await downloadFile(
      {
        url: resolution.downloadUrl,
        referer: resolution.referer,
        pageUrl: chosenResult.pageUrl,
        destinationDirectory: workspace.downloadDirectory,
        fallbackFileName: resolution.suggestedFileName ?? `${sanitizeFileName(chosenResult.title)}.download`,
      },
      httpClient,
    );
    if (download.kind === "blocked") {
      reportBlocked(chosenResult.sourceName, download, system);
      return;
    }

    await processAcquiredFile(download.filePath, {
      system,
      config,
      prompter,
      flags: args.flags,
      workspace,
      hints: [chosenResult.title, query],
      removeSourceWhenDone: true,
    });
  } catch (error) {
    // Point the user to the manual route for errors that happen after the download started.
    if (error instanceof RomkitError && !error.hint) {
      throw new RomkitError(error.message, `Page of the chosen result: ${chosenResult.pageUrl}`);
    }
    throw error;
  } finally {
    await workspace.dispose(args.flags.keepTemp);
  }
}

/** The system's sources in configured order, optionally narrowed by --source. */
function selectSources(config: ResolvedConfig, system: ResolvedSystem, sourceFilter: string | undefined): SourceConfig[] {
  const sourceByLowerName = new Map(config.sources.map((source) => [source.name.toLowerCase(), source]));
  const systemSources = system.sourceNames
    .map((sourceName) => sourceByLowerName.get(sourceName.toLowerCase()))
    .filter((source): source is SourceConfig => source !== undefined);

  if (systemSources.length === 0) {
    throw new RomkitError(
      `System ${system.id} has no sources configured.`,
      `In ${config.configPath}, either add "systems": ["${system.id}"] (or ["*"] for all systems) to a source, ` +
        `or list source names in "sources" of ${system.id}. You can also download manually and use \`romkit import\`.`,
    );
  }
  if (!sourceFilter) return systemSources;

  const filteredSources = systemSources.filter((source) => source.name.toLowerCase() === sourceFilter.toLowerCase());
  if (filteredSources.length === 0) {
    throw new RomkitError(
      `Source "${sourceFilter}" is not configured for ${system.id}. Available: ${systemSources.map((source) => source.name).join(", ")}.`,
    );
  }
  return filteredSources;
}

async function chooseResult(results: SearchResult[], prompter: Prompter, assumeYes: boolean): Promise<SearchResult | null> {
  const labels = results.map((result) => {
    // Show tags only when they are not already part of the visible title.
    const extraTags = result.regionTags.filter((tag) => !result.title.includes(tag));
    const tagText = extraTags.length > 0 ? style.yellow(`[${extraTags.join(", ")}]`) : "";
    const folderText = result.folder ? style.dim(`${result.folder}/`) : "";
    const sizeText = result.sizeText ? style.dim(result.sizeText) : "";
    return [folderText + result.title, tagText, sizeText, style.dim(`— ${result.sourceName}`)].filter(Boolean).join("  ");
  });

  if (results.length === 1) {
    logger.info(`Found: ${labels[0]}`);
    if (assumeYes) return results[0]!;
    return (await prompter.confirm("Download it?", true)) ? results[0]! : null;
  }

  const chosenIndex = await prompter.chooseFromList(`Found ${results.length} results:`, labels);
  return chosenIndex === null ? null : results[chosenIndex]!;
}
