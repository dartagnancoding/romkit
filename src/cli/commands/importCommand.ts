/**
 * romkit import <path> [-sys <system>] [--delete-source]
 *
 * Runs a manually downloaded file (archive or raw ROM) through the same
 * extract/identify/organize pipeline as `download`.
 * The original file is left untouched unless --delete-source is given.
 */

import { resolve } from "node:path";
import { resolveSystemFromFlagOrPrompt } from "../../config/systemResolver";
import { createWorkspace } from "../../download/tempWorkspace";
import { RomkitError, UsageError } from "../../errors";
import { ensureSevenZipAvailable } from "../../extraction/sevenZip";
import { logger } from "../../logging/logger";
import { isDirectory, pathExists } from "../../util/fileSystem";
import { processAcquiredFile } from "../../workflow/processAcquiredFile";
import type { CommandContext } from "../commandContext";

export async function runImportCommand(context: CommandContext): Promise<void> {
  const { args, config, prompter } = context;

  const typedPath = args.positionals.slice(1).join(" ").trim();
  if (typedPath === "") {
    throw new UsageError("Missing the file to import.", "Usage: romkit import <path> [-sys <system>]");
  }
  const inputPath = resolve(typedPath);
  if (!(await pathExists(inputPath))) throw new RomkitError(`File not found: ${inputPath}`);
  if (await isDirectory(inputPath)) {
    throw new UsageError(`${inputPath} is a folder.`, "Pass a file: an archive (.zip/.rar/.7z), a ROM, or a .cue sheet.");
  }

  const system = await resolveSystemFromFlagOrPrompt(config, args.flags.system, prompter);
  await ensureSevenZipAvailable(config.sevenZipPath);

  const workspace = await createWorkspace(config.tempDirectory);
  try {
    const outcome = await processAcquiredFile(inputPath, {
      system,
      config,
      prompter,
      flags: args.flags,
      workspace,
      hints: [],
      removeSourceWhenDone: args.flags.deleteSource,
    });
    if (outcome === "placed" && !args.flags.deleteSource) {
      logger.info(`The original file was left at ${inputPath} (use --delete-source to remove it automatically).`);
    }
  } finally {
    await workspace.dispose(args.flags.keepTemp);
  }
}
