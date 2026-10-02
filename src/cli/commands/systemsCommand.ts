/**
 * romkit systems                 list configured systems
 * romkit systems add [name]      add a system (suggestions from the built-in catalog)
 * romkit systems remove <id>     remove a system from the config (files are not touched)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { searchCatalog, type CatalogSystem } from "../../catalog/systemCatalog";
import { saveConfigFile } from "../../config/configLoader";
import type { ResolvedConfig, SystemConfig } from "../../config/configTypes";
import { requireSystem } from "../../config/systemResolver";
import { UsageError } from "../../errors";
import { logger } from "../../logging/logger";
import { compactKey } from "../../naming/titleNormalization";
import { ensureDirectory } from "../../util/fileSystem";
import { renderTable } from "../../util/format";
import type { CommandContext } from "../commandContext";
import type { Prompter } from "../prompts";
import { style } from "../terminalStyle";

export async function runSystemsCommand(context: CommandContext): Promise<void> {
  const subcommand = context.args.positionals[1]?.toLowerCase();
  switch (subcommand) {
    case undefined:
    case "list":
      listSystems(context.config);
      return;
    case "add":
      await addSystem(context);
      return;
    case "remove":
      await removeSystem(context);
      return;
    default:
      throw new UsageError(`Unknown subcommand "systems ${subcommand}".`, "Use: romkit systems [list | add | remove <id>]");
  }
}

function listSystems(config: ResolvedConfig): void {
  if (config.systems.length === 0) {
    logger.info("No systems configured yet. Add one with `romkit systems add`.");
    return;
  }
  logger.info(`Library: ${config.libraryRoot}\n`);
  const header = ["ID", "Name", "Folder", "Extensions", "DAT", "Sources"].map((title) => style.bold(title));
  const rows = config.systems.map((system) => {
    const datStatus = system.datPath ? (existsSync(system.datPath) ? style.green("yes") : style.red("missing")) : style.dim("—");
    const folderStatus = existsSync(system.folderPath) ? system.folderPath : `${system.folderPath} ${style.dim("(not created)")}`;
    return [
      style.cyan(system.id),
      system.name,
      folderStatus,
      system.extensions.join(" "),
      datStatus,
      system.sourceNames.join(", ") || style.dim("—"),
    ];
  });
  logger.info(renderTable([header, ...rows]));
}

async function addSystem(context: CommandContext): Promise<void> {
  const { config, prompter } = context;
  const rawFile = config.rawFile;

  const typedQuery = context.args.positionals.slice(2).join(" ").trim();
  const query = typedQuery || (await prompter.ask('Which system? (name or abbreviation, e.g. "gba", "playstation"):'));
  const preset = await choosePreset(query, prompter);
  if (preset === undefined) {
    logger.info("Cancelled.");
    return;
  }

  // Each answer defaults to the catalog value (or something sensible for a custom system).
  const systemId = await askSystemId(prompter, config, preset?.id ?? query.toUpperCase().replace(/[^A-Z0-9_-]/g, ""));
  const systemName = await prompter.ask("Display name:", preset?.name ?? systemId);
  const folder = await prompter.ask(`Folder inside ${config.libraryRoot}:`, systemId);
  const aliases = splitCommaList(await prompter.ask("Aliases (comma-separated):", (preset?.aliases ?? [systemId.toLowerCase()]).join(", ")));
  const extensions = await askExtensions(prompter, preset);
  if (extensions.includes(".cue")) {
    logger.info(style.dim("  Note: .bin/.wav tracks referenced by a .cue are handled automatically."));
  }

  const datHint = preset ? ` (look for the ${preset.datProvider} DAT "${preset.datName}")` : "";
  const datAnswer = (await prompter.ask(`DAT file path, optional${datHint}:`, "")).replace(/^"|"$/g, "");
  if (datAnswer && !existsSync(datAnswer)) {
    logger.warn(`  ${datAnswer} does not exist yet; it is saved anyway and used once the file is there.`);
  }

  const sourceNames = await askSources(prompter, config, systemId);

  const newSystem: SystemConfig = {
    id: systemId,
    name: systemName,
    aliases,
    folder,
    extensions,
    datPath: datAnswer || null,
    naming: { template: "{title}", keepTags: [] },
    sources: sourceNames,
  };

  logger.info(`\n${JSON.stringify(newSystem, null, 2)}`);
  if (!(await prompter.confirm("Save this system?", true))) {
    logger.info("Nothing was saved.");
    return;
  }

  rawFile.systems.push(newSystem);
  await saveConfigFile(config.configPath, rawFile);
  const folderPath = resolve(config.libraryRoot, folder);
  await ensureDirectory(folderPath);
  logger.success(`System ${systemId} added. Folder: ${folderPath}`);
}

/**
 * Returns a catalog preset, null for "enter everything manually",
 * or undefined when the user cancels.
 */
async function choosePreset(query: string, prompter: Prompter): Promise<CatalogSystem | null | undefined> {
  const matches = searchCatalog(query);
  if (matches.length === 0) {
    logger.info(`"${query}" is not in the built-in catalog; enter the details manually.`);
    return null;
  }
  const labels = [
    ...matches.map(
      (match) => `${style.cyan(match.id.padEnd(9))} ${match.name}  ${style.dim(match.extensions.join(" "))}`,
    ),
    style.dim("None of these: enter everything manually"),
  ];
  const chosenIndex = await prompter.chooseFromList("Matching systems:", labels);
  if (chosenIndex === null) return undefined;
  return matches[chosenIndex] ?? null;
}

async function askSystemId(prompter: Prompter, config: ResolvedConfig, defaultId: string): Promise<string> {
  while (true) {
    const systemId = (await prompter.ask("System id (used with -sys):", defaultId || undefined)).toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(systemId)) {
      logger.warn("  Use only letters, digits, - and _.");
      continue;
    }
    const takenBy = config.systems.find((system) =>
      [system.id, system.name, ...system.aliases].some((name) => compactKey(name) === compactKey(systemId)),
    );
    if (takenBy) {
      logger.warn(`  "${systemId}" is already used by system ${takenBy.id}.`);
      continue;
    }
    return systemId;
  }
}

async function askExtensions(prompter: Prompter, preset: CatalogSystem | null): Promise<string[]> {
  while (true) {
    const answer = await prompter.ask("Accepted extensions (comma-separated):", preset?.extensions.join(", "));
    const extensions = splitCommaList(answer).map((extension) => (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase());
    if (extensions.length > 0) return [...new Set(extensions)];
    logger.warn("  At least one extension is required, e.g. .gba");
  }
}

/** Lets the user pick global sources for this system, in order. Fills systemParams when needed. */
async function askSources(prompter: Prompter, config: ResolvedConfig, systemId: string): Promise<string[]> {
  const rawSources = config.rawFile.sources ?? [];
  if (rawSources.length === 0) {
    logger.info(style.dim("  No sources are defined in the config yet; you can add them later."));
    return [];
  }

  logger.info("Available sources:");
  rawSources.forEach((source, sourceIndex) => {
    const browserNote = source.requiresJavaScript ? style.dim(" (browser only)") : "";
    logger.info(`  ${style.cyan(String(sourceIndex + 1))}) ${source.name}${browserNote}`);
  });

  while (true) {
    const answer = await prompter.ask("Sources to use, in search order (e.g. 2,1; Enter for none):", "");
    const chosenNumbers = splitCommaList(answer).map((part) => Number.parseInt(part, 10));
    if (chosenNumbers.some((chosenNumber) => !(chosenNumber >= 1 && chosenNumber <= rawSources.length))) {
      logger.warn(`  Use numbers between 1 and ${rawSources.length}.`);
      continue;
    }

    const chosenSources = [...new Set(chosenNumbers)].map((chosenNumber) => rawSources[chosenNumber - 1]!);
    for (const source of chosenSources) {
      // A URL with {system} needs to know what this site calls the system (e.g. "gba", "psx").
      if (source.searchUrl.includes("{system}") && !source.systemParams?.[systemId]) {
        const value = await prompter.ask(`  What does ${source.name} call this system in its URL ({system})?`);
        source.systemParams = { ...source.systemParams, [systemId]: value };
      }
    }
    return chosenSources.map((source) => source.name);
  }
}

async function removeSystem(context: CommandContext): Promise<void> {
  const { config, prompter } = context;
  const typedId = context.args.positionals[2];
  if (!typedId) throw new UsageError("Missing the system id.", "Usage: romkit systems remove <id>");

  const system = requireSystem(config, typedId);
  const confirmed = await prompter.confirm(`Remove ${system.id} from the config? (files in ${system.folderPath} are not touched)`, false);
  if (!confirmed) {
    logger.info("Nothing was changed.");
    return;
  }

  config.rawFile.systems = config.rawFile.systems.filter((rawSystem) => rawSystem.id !== system.id);
  await saveConfigFile(config.configPath, config.rawFile);
  logger.success(`System ${system.id} removed from the config.`);
}

function splitCommaList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
