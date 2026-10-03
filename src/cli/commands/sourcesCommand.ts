/**
 * romkit sources                          list the sources and the systems they serve
 * romkit sources export <file> [-sys X]   save sources (and the systems they need) to share
 * romkit sources import <file or URL>     add sources from such a file; existing names are kept
 *
 * An export carries the definitions of the systems its sources serve, so importing
 * on another PC also creates those systems (folders inside that PC's libraryRoot).
 * Machine-specific settings (DAT paths, folders outside the library) are not exported.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import packageJson from "../../../package.json";
import { SYSTEM_CATALOG } from "../../catalog/systemCatalog";
import { readConfigFile, saveConfigFile, sourceAppliesToSystem } from "../../config/configLoader";
import { DEFAULT_HTTP_SETTINGS, type ConfigFile, type SourceConfig, type SystemConfig } from "../../config/configTypes";
import { RomkitError, UsageError } from "../../errors";
import { logger } from "../../logging/logger";
import { sanitizeFileName } from "../../naming/filenameSanitizer";
import { ensureDirectory } from "../../util/fileSystem";
import { renderTable } from "../../util/format";
import type { BasicCommandContext } from "../commandContext";
import { style } from "../terminalStyle";

/** The shareable file. A bare array of sources is accepted on import too. */
export interface SourcesExport {
  romkit: "sources";
  version: 1;
  sources: SourceConfig[];
  systems: SystemConfig[];
}

export async function runSourcesCommand(context: BasicCommandContext): Promise<void> {
  const subcommand = context.args.positionals[1]?.toLowerCase();
  const target = context.args.positionals.slice(2).join(" ").trim();
  switch (subcommand) {
    case undefined:
    case "list":
      listSources(await readConfigFile(context.configPath, { requireValidSources: false }));
      return;
    case "export":
      if (!target) throw new UsageError("Missing the file to write.", "Usage: romkit sources export <file.json> [-sys <system>]");
      await exportSources(context, target);
      return;
    case "import":
      if (!target) throw new UsageError("Missing the file or link to import.", "Usage: romkit sources import <file.json or https://...>");
      await importSourcesCommand(context, target);
      return;
    default:
      throw new UsageError(`Unknown subcommand "sources ${subcommand}".`, "Use: romkit sources [list | export <file> | import <file or URL>]");
  }
}

function listSources(file: ConfigFile): void {
  const sources = file.sources ?? [];
  if (sources.length === 0) {
    logger.info("No sources yet. Import some with `romkit sources import <file or link>`.");
    return;
  }
  const rows = sources.map((source) => [style.cyan(source.name), systemsServedBy(source, file).join(", ") || style.dim("—"), source.searchUrl]);
  logger.info(renderTable([["Source", "Systems", "URL"].map((title) => style.bold(title)), ...rows]));
  logger.info(style.dim(`\n${sources.length} source(s).`));
}

async function exportSources(context: BasicCommandContext, outputPath: string): Promise<void> {
  const file = await readConfigFile(context.configPath, { requireValidSources: false });
  const systemFilter = context.args.flags.system?.toLowerCase();
  const filterSystem = systemFilter
    ? file.systems.find((system) => system.id.toLowerCase() === systemFilter || (system.aliases ?? []).some((alias) => alias.toLowerCase() === systemFilter))
    : undefined;
  if (systemFilter && !filterSystem) throw new UsageError(`Unknown system "${context.args.flags.system}".`);

  const sources = (file.sources ?? []).filter((source) => !filterSystem || systemsServedBy(source, file).includes(filterSystem.id));
  const servedIds = new Set(sources.flatMap((source) => systemsServedBy(source, file)));
  const exported = buildExport(sources, file.systems.filter((system) => servedIds.has(system.id)));

  await writeFile(outputPath, `${JSON.stringify(exported, null, 2)}\n`, "utf8");
  logger.success(`Exported ${sources.length} source(s) and ${exported.systems.length} system(s) to ${resolve(outputPath)}`);
}

/** Systems without machine-specific parts: no DAT path, no folders outside the library, no source lists. */
export function buildExport(sources: SourceConfig[], systems: SystemConfig[]): SourcesExport {
  return {
    romkit: "sources",
    version: 1,
    sources,
    systems: systems.map((system) => {
      const { datPath: _datPath, sources: _sourceNames, ...portable } = system;
      return { ...portable, folder: isAbsolute(system.folder) ? sanitizeFileName(system.name ?? system.id) : system.folder };
    }),
  };
}

async function importSourcesCommand(context: BasicCommandContext, location: string): Promise<void> {
  const file = await readConfigFile(context.configPath, { requireValidSources: false });
  const incoming = parseSourcesFile(await readLocation(location), location);
  const plan = planImport(file, incoming);

  if (plan.addedSources.length === 0) {
    logger.info(`Nothing new: all ${plan.keptExisting.length} source(s) are already in the config.`);
    return;
  }
  logger.info(`${plan.addedSources.length} new source(s): ${summarizeNames(plan.addedSources.map((source) => source.name))}`);
  if (plan.addedSystems.length > 0) {
    logger.info(`New system(s) they need: ${plan.addedSystems.map((system) => `${system.id} (${system.name ?? system.id})`).join(", ")}`);
  }
  if (plan.keptExisting.length > 0) logger.info(style.dim(`Already in the config (kept as they are): ${summarizeNames(plan.keptExisting)}`));
  for (const skipped of plan.skippedSources) logger.warn(`Skipped ${skipped.name}: ${skipped.reason}`);

  if (!context.args.flags.yes && !(await context.prompter.confirm("Add them?", true))) {
    logger.info("Nothing was changed.");
    return;
  }
  applyImport(file, plan);
  await saveConfigFile(context.configPath, file);
  for (const system of plan.addedSystems) await ensureDirectory(resolve(file.libraryRoot, system.folder));
  logger.success(`Added ${plan.addedSources.length} source(s) and ${plan.addedSystems.length} system(s).`);
}

export async function readLocation(location: string): Promise<string> {
  if (/^https?:\/\//i.test(location)) {
    const response = await fetch(location, { headers: { "User-Agent": DEFAULT_HTTP_SETTINGS.userAgent } }).catch((error: Error) => {
      throw new RomkitError(`Could not download ${location}: ${error.message}`);
    });
    if (!response.ok) throw new RomkitError(`${location} answered HTTP ${response.status}.`);
    return response.text();
  }
  try {
    return await readFile(location, "utf8");
  } catch {
    throw new RomkitError(`Could not read ${location}.`);
  }
}

export function parseSourcesFile(text: string, location: string): SourcesExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new RomkitError(`${location} is not a JSON file.`);
  }
  if (Array.isArray(parsed)) return buildExport(parsed as SourceConfig[], []);
  const candidate = parsed as Partial<SourcesExport> | null;
  if (candidate && Array.isArray(candidate.sources)) {
    return buildExport(candidate.sources, Array.isArray(candidate.systems) ? candidate.systems : []);
  }
  throw new RomkitError(`${location} has no "sources" list.`, `Create one with \`romkit sources export\` (romkit ${packageJson.version}).`);
}

export interface ImportPlan {
  addedSources: SourceConfig[];
  addedSystems: SystemConfig[];
  /** Names already in the config; the existing source wins. */
  keptExisting: string[];
  skippedSources: { name: string; reason: string }[];
}

/**
 * Decides what an import adds. A source that needs a system the config lacks
 * brings it along: from the file when it carries the definition, else from the
 * built-in catalog. A source whose system is found nowhere is skipped.
 */
export function planImport(file: ConfigFile, incoming: SourcesExport): ImportPlan {
  const plan: ImportPlan = { addedSources: [], addedSystems: [], keptExisting: [], skippedSources: [] };
  const existingSourceNames = new Set((file.sources ?? []).map((source) => source.name.toLowerCase()));
  const knownSystemIds = new Set(file.systems.map((system) => system.id.toLowerCase()));

  for (const source of incoming.sources) {
    if (!source || typeof source.name !== "string") {
      plan.skippedSources.push({ name: "(unnamed)", reason: "not a valid source" });
      continue;
    }
    if (existingSourceNames.has(source.name.toLowerCase())) {
      plan.keptExisting.push(source.name);
      continue;
    }

    const neededIds = (Array.isArray(source.systems) ? source.systems : []).filter((id) => id !== "*");
    const newSystems: SystemConfig[] = [];
    const missingIds: string[] = [];
    for (const neededId of neededIds) {
      if (knownSystemIds.has(neededId.toLowerCase())) continue;
      const definition = incoming.systems.find((system) => system.id.toLowerCase() === neededId.toLowerCase()) ?? catalogSystem(neededId);
      if (definition) newSystems.push(definition);
      else missingIds.push(neededId);
    }
    if (missingIds.length > 0) {
      plan.skippedSources.push({ name: source.name, reason: `system ${missingIds.join(", ")} is not configured and the file does not define it` });
      continue;
    }

    for (const system of newSystems) {
      knownSystemIds.add(system.id.toLowerCase());
      plan.addedSystems.push(system);
    }
    existingSourceNames.add(source.name.toLowerCase());
    plan.addedSources.push(source);
  }
  return plan;
}

export function applyImport(file: ConfigFile, plan: ImportPlan): void {
  file.sources = [...(file.sources ?? []), ...plan.addedSources];
  file.systems.push(...plan.addedSystems.map((system) => ({ ...system, datPath: null, sources: [] })));
}

function catalogSystem(systemId: string): SystemConfig | null {
  const entry = SYSTEM_CATALOG.find((candidate) => candidate.id.toLowerCase() === systemId.toLowerCase());
  if (!entry) return null;
  return {
    id: entry.id,
    ...(entry.mode === "arcade" ? { mode: entry.mode } : {}),
    name: entry.name,
    aliases: entry.aliases,
    folder: sanitizeFileName(entry.name),
    extensions: entry.extensions,
    naming: { template: "{title}", keepTags: [] },
  };
}

/** Ids of the systems a source serves: its own "systems" list plus systems that list it by name. */
function systemsServedBy(source: SourceConfig, file: ConfigFile): string[] {
  return file.systems
    .filter((system) => sourceAppliesToSystem(source, system.id) || (system.sources ?? []).some((name) => name.toLowerCase() === source.name.toLowerCase()))
    .map((system) => system.id);
}

function summarizeNames(names: string[]): string {
  return names.length <= 6 ? names.join(", ") : `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`;
}
