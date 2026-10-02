/**
 * Finds, reads, validates and resolves romkit.config.json.
 *
 * Lookup order for the config file:
 *   1. --config <path>
 *   2. ROMKIT_CONFIG environment variable
 *   3. %APPDATA%\romkit\romkit.config.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RomkitError } from "../errors";
import { defaultLogFilePath, logger } from "../logging/logger";
import { ensureDirectory, pathExists } from "../util/fileSystem";
import {
  DEFAULT_ALIASES_FILE_NAME,
  DEFAULT_AUTO_ACCEPT_THRESHOLD,
  DEFAULT_HTTP_SETTINGS,
  DEFAULT_NAMING,
  type ConfigFile,
  type ResolvedConfig,
  type ResolvedSystem,
  type SystemConfig,
} from "./configTypes";
import { validateConfigFile } from "./configValidation";
import { parseJsonWithComments, stripJsonComments } from "./jsonc";

export function defaultConfigPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "romkit", "romkit.config.json");
}

export function locateConfigPath(explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  const environmentPath = process.env.ROMKIT_CONFIG;
  if (environmentPath && environmentPath.trim() !== "") return resolve(environmentPath.trim());
  return defaultConfigPath();
}

export async function readConfigFile(configPath: string): Promise<ConfigFile> {
  if (!(await pathExists(configPath))) {
    throw new RomkitError(
      `No config file found at ${configPath}.`,
      "Run `romkit init` to create one, or point to an existing file with --config <path> or the ROMKIT_CONFIG variable.",
    );
  }

  // Comments and trailing commas are allowed: the file is meant to be edited by hand.
  const parsed = parseJsonWithComments(await readFile(configPath, "utf8"), configPath);

  const problems = validateConfigFile(parsed);
  if (problems.length > 0) {
    const problemList = problems.map((problem) => `  - ${problem}`).join("\n");
    throw new RomkitError(`The config file ${configPath} has ${problems.length} problem(s):\n${problemList}`);
  }
  return parsed as ConfigFile;
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const rawFile = await readConfigFile(configPath);
  return resolveConfig(rawFile, configPath);
}

/** Applies defaults and turns every relative path into an absolute one. */
export function resolveConfig(rawFile: ConfigFile, configPath: string): ResolvedConfig {
  const configDirectory = dirname(configPath);
  const libraryRoot = resolve(configDirectory, rawFile.libraryRoot);

  return {
    configPath,
    configDirectory,
    libraryRoot,
    sevenZipPath: resolve(configDirectory, rawFile.sevenZipPath),
    tempDirectory: rawFile.tempDirectory ? resolve(configDirectory, rawFile.tempDirectory) : join(tmpdir(), "romkit"),
    logFile: rawFile.logFile ? resolve(configDirectory, rawFile.logFile) : defaultLogFilePath(),
    aliasesFilePath: resolve(configDirectory, rawFile.aliasesFile ?? DEFAULT_ALIASES_FILE_NAME),
    http: { ...DEFAULT_HTTP_SETTINGS, ...rawFile.http },
    autoAcceptThreshold: rawFile.matching?.autoAcceptThreshold ?? DEFAULT_AUTO_ACCEPT_THRESHOLD,
    sources: rawFile.sources ?? [],
    systems: rawFile.systems.map((system) => resolveSystem(system, libraryRoot, configDirectory)),
    rawFile,
  };
}

function resolveSystem(system: SystemConfig, libraryRoot: string, configDirectory: string): ResolvedSystem {
  return {
    id: system.id,
    mode: system.mode ?? "standard",
    name: system.name ?? system.id,
    aliases: system.aliases ?? [],
    folderPath: resolve(libraryRoot, system.folder),
    extensions: system.extensions.map((extension) => extension.toLowerCase()),
    datPath: system.datPath ? resolve(configDirectory, system.datPath) : null,
    naming: {
      template: system.naming?.template ?? DEFAULT_NAMING.template,
      keepTags: system.naming?.keepTags ?? DEFAULT_NAMING.keepTags,
    },
    compressToZip: system.compressToZip ?? false,
    sourceNames: system.sources ?? [],
  };
}

/** Validates and writes the config file (used by `init` and `systems add/remove`). */
export async function saveConfigFile(configPath: string, file: ConfigFile): Promise<void> {
  const problems = validateConfigFile(file);
  if (problems.length > 0) {
    throw new RomkitError(`Refusing to save an invalid config:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
  await ensureDirectory(dirname(configPath));
  // Saving rewrites the file from data, so hand-written comments cannot survive. Say so.
  if (await pathExists(configPath)) {
    const previousText = await readFile(configPath, "utf8");
    if (stripJsonComments(previousText) !== previousText.replace(/^﻿/, "")) {
      const backupPath = `${configPath}.bak`;
      await writeFile(backupPath, previousText, "utf8");
      logger.warn(`The comments in the config were removed when saving. The previous version is at ${backupPath}`);
    }
  }
  await writeFile(configPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}
