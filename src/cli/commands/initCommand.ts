/**
 * romkit init
 *
 * Creates the config file (and an empty alias table next to it), asking for the
 * library folder and locating 7-Zip.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { saveConfigFile } from "../../config/configLoader";
import { DEFAULT_ALIASES_FILE_NAME, DEFAULT_HTTP_SETTINGS, type ConfigFile } from "../../config/configTypes";
import { RomkitError } from "../../errors";
import { logger } from "../../logging/logger";
import { pathExists } from "../../util/fileSystem";
import type { BasicCommandContext } from "../commandContext";

const DEFAULT_LIBRARY_ROOT = "E:\\ROM";

export async function runInitCommand(context: BasicCommandContext): Promise<void> {
  const { configPath, prompter } = context;
  if (await pathExists(configPath)) {
    throw new RomkitError(`A config file already exists at ${configPath}.`, "Edit it directly, or pass --config <path> to create another one.");
  }

  logger.info(`Creating ${configPath}`);
  const libraryRoot = await prompter.ask("Library folder (one subfolder per system):", DEFAULT_LIBRARY_ROOT);

  const detectedSevenZip = await findSevenZip();
  if (detectedSevenZip) logger.info(`Found 7-Zip at ${detectedSevenZip}`);
  else logger.warn("7-Zip was not found automatically.");
  const sevenZipPath = await prompter.ask("Path to 7z.exe:", detectedSevenZip ?? "C:\\Program Files\\7-Zip\\7z.exe");

  const configFile: ConfigFile = {
    libraryRoot,
    sevenZipPath,
    tempDirectory: null,
    logFile: null,
    aliasesFile: DEFAULT_ALIASES_FILE_NAME,
    http: { ...DEFAULT_HTTP_SETTINGS },
    matching: { autoAcceptThreshold: 0.9 },
    sources: [],
    systems: [],
  };
  await saveConfigFile(configPath, configFile);

  const aliasesPath = join(dirname(configPath), DEFAULT_ALIASES_FILE_NAME);
  if (!(await pathExists(aliasesPath))) {
    await writeFile(aliasesPath, `${JSON.stringify({ "*": {} }, null, 2)}\n`, "utf8");
  }

  logger.success(`Config created: ${configPath}`);
  logger.info(`Alias table:    ${aliasesPath}`);
  logger.info("Next step: add your systems with `romkit systems add`.");
}

/** Standard install folders first, then anything named 7z on the PATH. */
async function findSevenZip(): Promise<string | null> {
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "7-Zip", "7z.exe"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return Bun.which("7z");
}
