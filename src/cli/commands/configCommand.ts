/**
 * romkit config                      show the main settings and change them interactively
 * romkit config <setting>            show one setting
 * romkit config <setting> <value>    change it ("default" resets an optional one)
 * romkit config open                 open the file in Notepad
 * romkit config path                 print where the file is
 *
 * Works on the file itself (not the resolved config), so a setting left at its
 * default stays unset and keeps following romkit's default.
 */

import { existsSync } from "node:fs";
import { readConfigFile, saveConfigFile } from "../../config/configLoader";
import type { ConfigFile } from "../../config/configTypes";
import { RomkitError, UsageError } from "../../errors";
import { logger } from "../../logging/logger";
import { renderTable } from "../../util/format";
import type { BasicCommandContext } from "../commandContext";
import { askForPath, unquote } from "../pathPrompt";
import type { Prompter } from "../prompts";
import { style } from "../terminalStyle";

interface SettingDefinition {
  /** Dotted path in the config file. */
  key: string;
  label: string;
  kind: "folder" | "file" | "choice" | "number" | "list";
  /** Optional settings can go back to the default with the value "default". */
  defaultText?: string;
  choices?: string[];
  filter?: string;
  min?: number;
  max?: number;
}

export const SETTINGS: SettingDefinition[] = [
  { key: "libraryRoot", label: "Library folder (one subfolder per system)", kind: "folder" },
  { key: "inboxDirectory", label: "Inbox folder for `romkit inbox`", kind: "folder", defaultText: "%USERPROFILE%\\Downloads\\dump" },
  { key: "sevenZipPath", label: "7-Zip (7z.exe)", kind: "file", filter: "7-Zip|7z.exe|All files|*.*" },
  { key: "tempDirectory", label: "Temporary folder (downloads in progress, list cache)", kind: "folder", defaultText: "%TEMP%\\romkit" },
  { key: "download.tool", label: "Downloader", kind: "choice", choices: ["auto", "aria2c", "builtin"], defaultText: "auto" },
  { key: "download.connections", label: "aria2c connections per file", kind: "number", min: 1, max: 16, defaultText: "4" },
  { key: "download.parallel", label: "Games downloaded at the same time by `romkit queue run`", kind: "number", min: 1, max: 4, defaultText: "2" },
  { key: "download.aria2cPath", label: "aria2c.exe", kind: "file", filter: "aria2c|aria2c.exe|All files|*.*", defaultText: "found automatically" },
  { key: "preferences.regionOrder", label: "Preferred regions, best first", kind: "list", defaultText: "USA, World, Europe, Japan" },
  { key: "preferences.translations", label: "Fan translations: avoid, prefer or neutral", kind: "choice", choices: ["avoid", "prefer", "neutral"], defaultText: "avoid" },
  { key: "matching.autoAcceptThreshold", label: "Accept names without asking from this confidence (0 to 1)", kind: "number", min: 0, max: 1, defaultText: "0.9" },
];

const RESET_WORD = "default";

export async function runConfigCommand(context: BasicCommandContext): Promise<void> {
  const { args, configPath, prompter } = context;
  const [, firstArgument, ...valueWords] = args.positionals;

  if (firstArgument?.toLowerCase() === "path") {
    console.log(configPath);
    return;
  }
  if (firstArgument?.toLowerCase() === "open") {
    if (!existsSync(configPath)) throw new RomkitError(`There is no config at ${configPath} yet.`, "Create it with `romkit init`.");
    Bun.spawn(["notepad.exe", configPath], { stdout: "ignore", stderr: "ignore" }).unref();
    logger.info(`Opened ${configPath}`);
    return;
  }

  const file = await readConfigFile(configPath, { requireValidSources: false });
  if (!firstArgument) {
    printSettings(file, configPath);
    if (process.stdin.isTTY) await editInteractively(file, configPath, prompter);
    return;
  }

  const setting = findSetting(firstArgument);
  if (valueWords.length === 0) {
    console.log(describeValue(setting, getValue(file, setting.key)));
    return;
  }
  const value = parseValue(setting, valueWords.join(" "));
  await applyChange(file, configPath, setting, value);
}

function printSettings(file: ConfigFile, configPath: string): void {
  logger.info(`Config: ${configPath}\n`);
  const rows = SETTINGS.map((setting, index) => [
    style.cyan(String(index + 1).padStart(2)),
    setting.key,
    describeValue(setting, getValue(file, setting.key)),
  ]);
  logger.info(renderTable(rows));
  logger.info(style.dim(`\nChange one with: romkit config <setting> <value>   ("${RESET_WORD}" resets an optional one)`));
}

async function editInteractively(file: ConfigFile, configPath: string, prompter: Prompter): Promise<void> {
  while (true) {
    const answer = (await prompter.ask(`\nChange which setting? [1-${SETTINGS.length}, Enter to finish]`)).trim();
    if (answer === "") return;
    const setting = SETTINGS[Number.parseInt(answer, 10) - 1];
    if (!setting || String(Number.parseInt(answer, 10)) !== answer) {
      console.log(style.yellow(`Type a number between 1 and ${SETTINGS.length}.`));
      continue;
    }
    const value = await askNewValue(setting, getValue(file, setting.key), prompter);
    if (value === undefined) continue;
    try {
      await applyChange(file, configPath, setting, value);
    } catch (error) {
      if (!(error instanceof RomkitError)) throw error;
      logger.error(error.message);
    }
  }
}

/** undefined = left unchanged. */
async function askNewValue(setting: SettingDefinition, current: unknown, prompter: Prompter): Promise<unknown> {
  console.log(`${style.bold(setting.label)}  ${style.dim(`now: ${describeValue(setting, current)}`)}`);
  if (setting.kind === "choice") {
    const labels = setting.choices!.map((choice) => (choice === setting.defaultText ? `${choice} ${style.dim("(default)")}` : choice));
    const index = await prompter.chooseFromList(setting.label, labels);
    return index === null ? undefined : setting.choices![index];
  }
  if (setting.kind === "folder" || setting.kind === "file") {
    const currentText = typeof current === "string" ? current : undefined;
    const answer = await askForPath(prompter, { question: setting.label, kind: setting.kind, defaultValue: currentText, filter: setting.filter });
    return answer === currentText ? undefined : parseValue(setting, answer);
  }
  const currentText = current === undefined || current === null ? "" : Array.isArray(current) ? current.join(", ") : String(current);
  const resetHint = setting.defaultText ? style.dim(` ("${RESET_WORD}" = ${setting.defaultText})`) : "";
  const answer = await prompter.ask(`New value${resetHint}:`, currentText || undefined);
  if (answer.trim() === "" || answer === currentText) return undefined;
  try {
    return parseValue(setting, answer);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    logger.error(error.message);
    return undefined;
  }
}

async function applyChange(file: ConfigFile, configPath: string, setting: SettingDefinition, value: unknown): Promise<void> {
  const previous = getValue(file, setting.key);
  setValue(file, setting.key, value);
  await saveConfigFile(configPath, file);
  logger.success(`${setting.key} = ${describeValue(setting, value)}`);

  if ((setting.kind === "folder" || setting.kind === "file") && typeof value === "string" && !existsSync(value)) {
    logger.warn(`${value} does not exist (yet).`);
  }
  if (setting.key === "libraryRoot" && typeof previous === "string" && previous !== value) {
    logger.info(style.dim(`Files already in ${previous} were not moved.`));
  }
}

/** Accepts the full key or its last part: "connections" → "download.connections". Case does not matter. */
export function findSetting(name: string): SettingDefinition {
  const lowerName = name.toLowerCase();
  const exact = SETTINGS.find((setting) => setting.key.toLowerCase() === lowerName);
  if (exact) return exact;
  const byLastPart = SETTINGS.filter((setting) => setting.key.split(".").pop()!.toLowerCase() === lowerName);
  if (byLastPart.length === 1) return byLastPart[0]!;
  throw new UsageError(`Unknown setting "${name}".`, `Settings: ${SETTINGS.map((setting) => setting.key).join(", ")}.`);
}

export function parseValue(setting: SettingDefinition, rawText: string): unknown {
  const text = unquote(rawText);
  if (text.toLowerCase() === RESET_WORD) {
    if (!setting.defaultText) throw new UsageError(`${setting.key} has no default; give it a value.`);
    return null;
  }
  switch (setting.kind) {
    case "folder":
    case "file":
      return text;
    case "choice": {
      const choice = setting.choices!.find((candidate) => candidate === text.toLowerCase());
      if (!choice) throw new UsageError(`${setting.key} must be one of: ${setting.choices!.join(", ")}.`);
      return choice;
    }
    case "number": {
      const number = Number(text.replace(",", "."));
      if (!Number.isFinite(number) || number < setting.min! || number > setting.max!) {
        throw new UsageError(`${setting.key} must be a number from ${setting.min} to ${setting.max}.`);
      }
      return number;
    }
    case "list": {
      const items = text.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
      if (items.length === 0) throw new UsageError(`${setting.key} needs at least one item, e.g. "USA, Europe, Japan".`);
      return items;
    }
  }
}

function describeValue(setting: SettingDefinition, value: unknown): string {
  if (value === undefined || value === null) return style.dim(`${setting.defaultText ?? "not set"} (default)`);
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function getValue(file: ConfigFile, key: string): unknown {
  let current: unknown = file;
  for (const part of key.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * null resets: a top-level path keeps `null` (the style the file already uses),
 * a nested one is removed so the section's default applies again.
 */
export function setValue(file: ConfigFile, key: string, value: unknown): void {
  const parts = key.split(".");
  let target = file as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    if (target[part] === null || typeof target[part] !== "object") target[part] = {};
    target = target[part] as Record<string, unknown>;
  }
  const lastPart = parts.at(-1)!;
  if (value === null && parts.length > 1) delete target[lastPart];
  else target[lastPart] = value;
}
