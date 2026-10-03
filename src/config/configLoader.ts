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
  DEFAULT_DOWNLOAD_SETTINGS,
  DEFAULT_HTTP_SETTINGS,
  DEFAULT_NAMING,
  DEFAULT_PREFERENCES,
  type ConfigFile,
  type ResolvedConfig,
  type ResolvedSystem,
  type SourceConfig,
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

/** Problems that only matter when searching sources (i.e. for `download`). */
const SOURCE_PROBLEM_PATTERN = /^sources\[|^Source "|^systems\[\d+\]\.sources/;

export interface ConfigLoadOptions {
  /**
   * false: problems in the download sources are only warnings, so commands that
   * never download (import, inbox, organize...) keep working while a source is
   * being fixed.
   */
  requireValidSources: boolean;
}

export async function readConfigFile(configPath: string, options: ConfigLoadOptions = { requireValidSources: true }): Promise<ConfigFile> {
  if (!(await pathExists(configPath))) {
    throw new RomkitError(
      `No config file found at ${configPath}.`,
      "Run `romkit init` to create one, or point to an existing file with --config <path> or the ROMKIT_CONFIG variable.",
    );
  }

  // Comments and trailing commas are allowed: the file is meant to be edited by hand.
  const parsed = parseJsonWithComments(await readFile(configPath, "utf8"), configPath);

  const problems = validateConfigFile(parsed);
  const sourceProblems = problems.filter((problem) => SOURCE_PROBLEM_PATTERN.test(problem));
  const blockingProblems = options.requireValidSources ? problems : problems.filter((problem) => !SOURCE_PROBLEM_PATTERN.test(problem));

  if (blockingProblems.length > 0) {
    const problemList = blockingProblems.map((problem) => `  - ${problem}`).join("\n");
    throw new RomkitError(`The config file ${configPath} has ${blockingProblems.length} problem(s):\n${problemList}`);
  }
  if (sourceProblems.length > 0) {
    logger.warn(`The download sources in the config have ${sourceProblems.length} problem(s); \`romkit download\` will not work until they are fixed.`);
    for (const problem of sourceProblems) logger.debug(`  - ${problem}`);
  }
  return parsed as ConfigFile;
}

export async function loadConfig(configPath: string, options?: ConfigLoadOptions): Promise<ResolvedConfig> {
  const rawFile = await readConfigFile(configPath, options);
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
    inboxDirectory: rawFile.inboxDirectory
      ? resolve(configDirectory, rawFile.inboxDirectory)
      : join(homedir(), "Downloads", "dump"),
    logFile: rawFile.logFile ? resolve(configDirectory, rawFile.logFile) : defaultLogFilePath(),
    aliasesFilePath: resolve(configDirectory, rawFile.aliasesFile ?? DEFAULT_ALIASES_FILE_NAME),
    http: { ...DEFAULT_HTTP_SETTINGS, ...rawFile.http },
    download: {
      ...DEFAULT_DOWNLOAD_SETTINGS,
      ...rawFile.download,
      aria2cPath: rawFile.download?.aria2cPath ? resolve(configDirectory, rawFile.download.aria2cPath) : null,
    },
    autoAcceptThreshold: rawFile.matching?.autoAcceptThreshold ?? DEFAULT_AUTO_ACCEPT_THRESHOLD,
    sources: rawFile.sources ?? [],
    systems: rawFile.systems.map((system) => resolveSystem(system, rawFile, libraryRoot, configDirectory)),
    rawFile,
  };
}

/** True when a source opts into this system through its own "systems" list. */
export function sourceAppliesToSystem(source: SourceConfig, systemId: string): boolean {
  // Array check: an invalid source can reach this point when its problems are only warnings.
  return (Array.isArray(source.systems) ? source.systems : []).some((listedId) => listedId === "*" || listedId.toLowerCase() === systemId.toLowerCase());
}

/**
 * The sources a system searches, in order: first the ones the system lists itself,
 * then the ones that opt into it via their own "systems" field (in config order).
 */
export function effectiveSourceNames(system: SystemConfig, sources: SourceConfig[]): string[] {
  const sourceNames = [...(system.sources ?? [])];
  const listedLowerNames = new Set(sourceNames.map((sourceName) => sourceName.toLowerCase()));
  for (const source of sources) {
    if (sourceAppliesToSystem(source, system.id) && !listedLowerNames.has(source.name.toLowerCase())) {
      sourceNames.push(source.name);
      listedLowerNames.add(source.name.toLowerCase());
    }
  }
  return sourceNames;
}

function resolveSystem(system: SystemConfig, rawFile: ConfigFile, libraryRoot: string, configDirectory: string): ResolvedSystem {
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
    sourceNames: effectiveSourceNames(system, rawFile.sources ?? []),
    // System settings override the top-level ones, which override the defaults.
    preferences: { ...DEFAULT_PREFERENCES, ...rawFile.preferences, ...system.preferences },
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
