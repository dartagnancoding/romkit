/**
 * romkit init
 *
 * Creates the config file (and an empty alias table next to it): asks for the
 * library and inbox folders, finds 7-Zip and aria2c (offering to install them
 * with winget), and optionally imports a sources file or link.
 */

import { lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { saveConfigFile } from "../../config/configLoader";
import { DEFAULT_ALIASES_FILE_NAME, DEFAULT_HTTP_SETTINGS, type ConfigFile } from "../../config/configTypes";
import { findAria2c } from "../../download/aria2c";
import { RomkitError } from "../../errors";
import { logger } from "../../logging/logger";
import { ensureDirectory, pathExists } from "../../util/fileSystem";
import type { BasicCommandContext } from "../commandContext";
import { askForPath, unquote } from "../pathPrompt";
import type { Prompter } from "../prompts";
import { style } from "../terminalStyle";
import { applyImport, parseSourcesFile, planImport, readLocation } from "./sourcesCommand";

const DEFAULT_LIBRARY_ROOT = "E:\\ROM";

export async function runInitCommand(context: BasicCommandContext): Promise<void> {
  const { configPath, prompter } = context;
  if (await pathExists(configPath)) {
    throw new RomkitError(`A config file already exists at ${configPath}.`, "Change it with `romkit config`, or pass --config <path> to create another one.");
  }

  logger.info(`Creating ${configPath}\n`);
  const libraryRoot = await askForPath(prompter, { question: "Library folder (one subfolder per system):", kind: "folder", defaultValue: DEFAULT_LIBRARY_ROOT });
  const defaultInbox = join(homedir(), "Downloads", "dump");
  const inboxDirectory = await askForPath(prompter, {
    question: "Inbox folder (drop files here and run `romkit inbox`):",
    kind: "folder",
    defaultValue: defaultInbox,
  });

  const sevenZipPath = await locateSevenZip(prompter);
  await offerAria2c(prompter);

  const configFile: ConfigFile = {
    libraryRoot,
    sevenZipPath,
    tempDirectory: null,
    inboxDirectory: inboxDirectory === defaultInbox ? null : inboxDirectory,
    logFile: null,
    aliasesFile: DEFAULT_ALIASES_FILE_NAME,
    http: { ...DEFAULT_HTTP_SETTINGS },
    matching: { autoAcceptThreshold: 0.9 },
    sources: [],
    systems: [],
  };
  await offerSourcesImport(prompter, configFile);
  await saveConfigFile(configPath, configFile);
  await ensureDirectory(libraryRoot);
  await ensureDirectory(inboxDirectory);
  for (const system of configFile.systems) await ensureDirectory(resolve(libraryRoot, system.folder));

  const aliasesPath = join(dirname(configPath), DEFAULT_ALIASES_FILE_NAME);
  if (!(await pathExists(aliasesPath))) {
    await writeFile(aliasesPath, `${JSON.stringify({ "*": {} }, null, 2)}\n`, "utf8");
  }

  logger.success(`\nConfig created: ${configPath}`);
  logger.info(`Alias table:    ${aliasesPath}`);
  logger.info(`Change any of this later with ${style.cyan("romkit config")}.`);
  logger.info(
    configFile.systems.length > 0
      ? `Systems ready: ${configFile.systems.map((system) => system.id).join(", ")}. Try ${style.cyan("romkit download <game> -sys <system>")}.`
      : `Next step: add your systems with ${style.cyan("romkit systems add")}.`,
  );
}

async function locateSevenZip(prompter: Prompter): Promise<string> {
  let detected = await findSevenZip();
  if (!detected && (await offerWingetInstall(prompter, "7-Zip (needed to extract zip, 7z and rar)", "7zip.7zip"))) {
    detected = await findSevenZip();
  }
  if (detected) {
    logger.info(`7-Zip: ${detected}`);
    return detected;
  }
  logger.warn("7-Zip was not found.");
  return askForPath(prompter, {
    question: "Path to 7z.exe:",
    kind: "file",
    defaultValue: "C:\\Program Files\\7-Zip\\7z.exe",
    filter: "7-Zip|7z.exe|All files|*.*",
  });
}

/** aria2c is optional (faster downloads); romkit finds it by itself once installed. */
async function offerAria2c(prompter: Prompter): Promise<void> {
  const found = findAria2c();
  if (found) {
    logger.info(`aria2c: ${found} ${style.dim("(faster downloads, several connections per file)")}`);
    return;
  }
  if (await offerWingetInstall(prompter, "aria2c (optional: faster downloads, several connections per file)", "aria2.aria2")) {
    const installed = findAria2c();
    if (installed) logger.info(`aria2c: ${installed}`);
  }
}

async function offerSourcesImport(prompter: Prompter, configFile: ConfigFile): Promise<void> {
  const answer = unquote(await prompter.ask(`Sources file or link to import ${style.dim("(Enter to skip)")}:`, ""));
  if (answer === "") return;
  try {
    const plan = planImport(configFile, parseSourcesFile(await readLocation(answer), answer));
    for (const skipped of plan.skippedSources) logger.warn(`Skipped ${skipped.name}: ${skipped.reason}`);
    applyImport(configFile, plan);
    logger.info(`Imported ${plan.addedSources.length} source(s) and ${plan.addedSystems.length} system(s).`);
  } catch (error) {
    if (!(error instanceof RomkitError)) throw error;
    logger.warn(`${error.message} Import later with \`romkit sources import <file or link>\`.`);
  }
}

/** Asks, then runs winget in this terminal. True when winget reported success. */
async function offerWingetInstall(prompter: Prompter, description: string, packageId: string): Promise<boolean> {
  if (!isWingetAvailable()) {
    logger.info(style.dim(`${description} is not installed.`));
    return false;
  }
  if (!(await prompter.confirm(`${description} is not installed. Install it now with winget?`, true))) return false;
  logger.info(style.dim(`winget install --id ${packageId} -e`));
  // winget is an "app execution alias" that cannot be started directly, only through a shell.
  const child = Bun.spawn(["cmd.exe", "/d", "/c", "winget", "install", "--id", packageId, "-e", "--accept-source-agreements", "--accept-package-agreements"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const succeeded = (await child.exited) === 0;
  if (!succeeded) logger.warn(`winget could not install ${packageId}.`);
  return succeeded;
}

function isWingetAvailable(): boolean {
  if (process.platform !== "win32") return false;
  const alias = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Microsoft", "WindowsApps", "winget.exe");
  try {
    // existsSync follows the alias link and reports false; lstat sees the link itself.
    lstatSync(alias);
    return true;
  } catch {
    return Bun.which("winget") !== null;
  }
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
