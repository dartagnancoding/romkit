/**
 * romkit download <title> [-sys <system>] [--source <name>]
 *
 * Searches the system's sources in order, lets the user pick a result, downloads
 * it to a temp folder and hands it to the shared extract/identify/organize pipeline.
 * Until the file is complete it is listed in the queue, so `romkit queue run`
 * (or the same command again) continues an interrupted download.
 */

import { join } from "node:path";
import { resolveSystemFromFlagOrPrompt } from "../../config/systemResolver";
import { resolveDownloader } from "../../download/aria2c";
import { createWorkspace } from "../../download/tempWorkspace";
import { RomkitError, UsageError } from "../../errors";
import { ensureSevenZipAvailable } from "../../extraction/sevenZip";
import { DownloadQueue } from "../../queue/downloadQueue";
import { HttpClient } from "../../sources/httpClient";
import { ListPageCache } from "../../sources/listPageCache";
import { acquireResult, searchAndChoose } from "../../workflow/gameDownload";
import { processAcquiredFile } from "../../workflow/processAcquiredFile";
import type { CommandContext } from "../commandContext";

export async function runDownloadCommand(context: CommandContext): Promise<void> {
  const { args, config, prompter } = context;

  // Words after "download" form the title, so quotes are optional: romkit download mega man zero 4
  const typedQuery = args.positionals.slice(1).join(" ").trim();
  if (typedQuery === "") {
    throw new UsageError("Missing the title to search for.", "Usage: romkit download <title> [-sys <system>]");
  }

  const system = await resolveSystemFromFlagOrPrompt(config, args.flags.system, prompter);
  // Fail before downloading anything if 7-Zip (or a required aria2c) is missing.
  await ensureSevenZipAvailable(config.sevenZipPath);
  const downloader = resolveDownloader(config.download);

  const httpClient = new HttpClient(config.http);
  // --refresh skips reading the cache but still saves the fresh copies.
  const listCache = new ListPageCache(join(config.tempDirectory, "list-cache"), args.flags.refresh ? 0 : undefined);
  const chosen = await searchAndChoose({ config, system, httpClient, listCache, prompter, flags: args.flags }, typedQuery, "Download it?");
  if (!chosen) return;

  const workspace = await createWorkspace(config.tempDirectory);
  try {
    const acquired = await acquireResult({
      config,
      system,
      httpClient,
      downloader,
      adapter: chosen.adapter,
      result: chosen.result,
      query: chosen.query,
      workspace,
      queue: DownloadQueue.besideConfig(config.configPath),
    });
    if (acquired.kind === "blocked") return;

    await processAcquiredFile(acquired.filePath, {
      system,
      config,
      prompter,
      flags: args.flags,
      workspace,
      hints: [chosen.result.title, chosen.query],
      removeSourceWhenDone: true,
    });
  } catch (error) {
    // Point the user to the manual route for errors that happen after the download started.
    if (error instanceof RomkitError && !error.hint) {
      throw new RomkitError(error.message, `Page of the chosen result: ${chosen.result.pageUrl}`);
    }
    throw error;
  } finally {
    await workspace.dispose(args.flags.keepTemp);
  }
}
