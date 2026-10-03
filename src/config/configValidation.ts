/**
 * Validates the raw JSON of romkit.config.json.
 *
 * Collects every problem (instead of stopping at the first) and describes each
 * with its JSON path, e.g. `systems[1].extensions[0] must start with "."`.
 */

import { compactKey } from "../naming/titleNormalization";
import { knownAdapterNames } from "../sources/sourceRegistry";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const SYSTEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateConfigFile(raw: unknown): string[] {
  const problems: string[] = [];

  if (!isObject(raw)) {
    return ["The config file must contain a JSON object ({ ... })."];
  }

  if (!isNonEmptyString(raw.libraryRoot)) problems.push(`"libraryRoot" must be a folder path.`);
  if (!isNonEmptyString(raw.sevenZipPath)) problems.push(`"sevenZipPath" must be the path to 7z.exe.`);

  for (const optionalPathKey of ["tempDirectory", "inboxDirectory", "logFile", "aliasesFile"]) {
    const value = raw[optionalPathKey];
    if (value !== undefined && value !== null && !isNonEmptyString(value)) {
      problems.push(`"${optionalPathKey}" must be a path or null.`);
    }
  }

  validateHttpSettings(raw.http, problems);
  validateDownloadSettings(raw.download, problems);
  validateMatching(raw.matching, problems);
  validatePreferences(raw.preferences, `"preferences"`, problems);
  const sourcesByName = validateSources(raw.sources, problems);
  validateSystems(raw.systems, sourcesByName, problems);
  validateSourceSystemLists(raw.sources, raw.systems, problems);

  return problems;
}

/**
 * Checks each source's own "systems" list: ids must exist (or be "*"), and a
 * source whose URL has {system} needs a systemParams value for every system it covers.
 */
function validateSourceSystemLists(sources: unknown, systems: unknown, problems: string[]): void {
  if (!Array.isArray(sources) || !Array.isArray(systems)) return;
  const systemIds = systems.filter(isObject).map((system) => system.id).filter(isNonEmptyString);

  sources.forEach((source, sourceIndex) => {
    if (!isObject(source) || source.systems === undefined) return;
    const location = `sources[${sourceIndex}].systems`;
    if (!Array.isArray(source.systems) || !source.systems.every(isNonEmptyString)) {
      problems.push(`${location} must be a list of system ids, or ["*"] for all systems.`);
      return;
    }

    const coveredIds: string[] = [];
    for (const listedId of source.systems) {
      if (listedId === "*") {
        coveredIds.push(...systemIds);
        continue;
      }
      const matchingId = systemIds.find((systemId) => systemId.toLowerCase() === listedId.toLowerCase());
      if (matchingId) coveredIds.push(matchingId);
      else problems.push(`${location}: "${listedId}" is not a configured system id (configured: ${systemIds.join(", ") || "none"}).`);
    }

    const searchUrl = typeof source.searchUrl === "string" ? source.searchUrl : "";
    const params = isObject(source.systemParams) ? source.systemParams : {};
    if (searchUrl.includes("{system}")) {
      const missingIds = [...new Set(coveredIds)].filter((systemId) => !isNonEmptyString(params[systemId]));
      if (missingIds.length > 0) {
        problems.push(
          `Source "${String(source.name)}" uses {system} in its searchUrl but has no systemParams entry for: ${missingIds.join(", ")}.`,
        );
      }
    }
  });
}

function validateHttpSettings(http: unknown, problems: string[]): void {
  if (http === undefined) return;
  if (!isObject(http)) {
    problems.push(`"http" must be an object.`);
    return;
  }
  if (http.userAgent !== undefined && !isNonEmptyString(http.userAgent)) problems.push(`"http.userAgent" must be a string.`);
  if (http.timeoutMs !== undefined && !(typeof http.timeoutMs === "number" && http.timeoutMs > 0)) {
    problems.push(`"http.timeoutMs" must be a positive number of milliseconds.`);
  }
  if (http.delayBetweenRequestsMs !== undefined && !(typeof http.delayBetweenRequestsMs === "number" && http.delayBetweenRequestsMs >= 0)) {
    problems.push(`"http.delayBetweenRequestsMs" must be zero or a positive number of milliseconds.`);
  }
}

function validateDownloadSettings(download: unknown, problems: string[]): void {
  if (download === undefined) return;
  if (!isObject(download)) {
    problems.push(`"download" must be an object.`);
    return;
  }
  if (download.tool !== undefined && !["auto", "aria2c", "builtin"].includes(download.tool as string)) {
    problems.push(`"download.tool" must be "auto", "aria2c" or "builtin".`);
  }
  const connections = download.connections;
  if (connections !== undefined && !(Number.isInteger(connections) && (connections as number) >= 1 && (connections as number) <= 16)) {
    problems.push(`"download.connections" must be a whole number from 1 to 16.`);
  }
  const parallel = download.parallel;
  if (parallel !== undefined && !(Number.isInteger(parallel) && (parallel as number) >= 1 && (parallel as number) <= 4)) {
    problems.push(`"download.parallel" must be a whole number from 1 to 4.`);
  }
  if (download.aria2cPath != null && !isNonEmptyString(download.aria2cPath)) problems.push(`"download.aria2cPath" must be a path or null.`);
}

function validateMatching(matching: unknown, problems: string[]): void {
  if (matching === undefined) return;
  if (!isObject(matching)) {
    problems.push(`"matching" must be an object.`);
    return;
  }
  const threshold = matching.autoAcceptThreshold;
  if (threshold !== undefined && !(typeof threshold === "number" && threshold >= 0 && threshold <= 1)) {
    problems.push(`"matching.autoAcceptThreshold" must be a number between 0 and 1.`);
  }
}

function validatePreferences(preferences: unknown, location: string, problems: string[]): void {
  if (preferences === undefined) return;
  if (!isObject(preferences)) {
    problems.push(`${location} must be an object.`);
    return;
  }
  const { regionOrder, translations } = preferences;
  if (regionOrder !== undefined && (!Array.isArray(regionOrder) || !regionOrder.every(isNonEmptyString))) {
    problems.push(`${location}.regionOrder must be a list of region names, e.g. ["USA", "World", "Europe", "Japan"].`);
  }
  if (translations !== undefined && translations !== "avoid" && translations !== "prefer" && translations !== "neutral") {
    problems.push(`${location}.translations must be "avoid", "prefer" or "neutral".`);
  }
}

/** Returns the valid sources by lowercase name, so systems can check their references. */
function validateSources(sources: unknown, problems: string[]): Map<string, JsonObject> {
  const sourcesByName = new Map<string, JsonObject>();
  if (sources === undefined) return sourcesByName;
  if (!Array.isArray(sources)) {
    problems.push(`"sources" must be a list.`);
    return sourcesByName;
  }

  const adapterNames = knownAdapterNames();

  sources.forEach((source, sourceIndex) => {
    const location = `sources[${sourceIndex}]`;
    if (!isObject(source)) {
      problems.push(`${location} must be an object.`);
      return;
    }
    if (!isNonEmptyString(source.name)) {
      problems.push(`${location}.name is required.`);
      return;
    }
    const lowerName = source.name.toLowerCase();
    if (sourcesByName.has(lowerName)) problems.push(`${location}: duplicate source name "${source.name}".`);
    sourcesByName.set(lowerName, source);

    const adapterName = source.adapter ?? "selector";
    if (typeof adapterName !== "string" || !adapterNames.includes(adapterName)) {
      problems.push(`${location}.adapter "${String(adapterName)}" is unknown. Known adapters: ${adapterNames.join(", ")}.`);
    }
    if (!isNonEmptyString(source.searchUrl)) {
      problems.push(`${location}.searchUrl is required.`);
    } else if (!source.searchUrl.includes("{query}") && adapterName !== "selector") {
      // Only the selector adapter has a list mode (a page with every game, filtered locally).
      problems.push(`${location}.searchUrl must contain the {query} placeholder.`);
    } else {
      // Anything else in braces would be sent to the site literally (e.g. "%7Bconsole%7D").
      const unknownPlaceholders = [...source.searchUrl.matchAll(/\{([^{}]*)\}/g)]
        .map((match) => match[0])
        .filter((placeholder) => placeholder !== "{query}" && placeholder !== "{system}");
      if (unknownPlaceholders.length > 0) {
        problems.push(
          `${location}.searchUrl has unknown placeholder(s) ${[...new Set(unknownPlaceholders)].join(", ")}. ` +
            `Only {query} and {system} exist; {system} is filled from "systemParams", e.g. { "PS1": "<the site's name for PS1>" }.`,
        );
      }
    }
    if (source.requiresJavaScript !== undefined && typeof source.requiresJavaScript !== "boolean") {
      problems.push(`${location}.requiresJavaScript must be true or false.`);
    }
    // Optional fields accept null as "not set".
    if (source.noResultsText != null && !isNonEmptyString(source.noResultsText)) {
      problems.push(`${location}.noResultsText must be a string or null.`);
    }
    if (source.systemParams !== undefined) {
      const params = source.systemParams;
      if (!isObject(params) || !Object.values(params).every(isNonEmptyString)) {
        problems.push(`${location}.systemParams must map system ids to strings, e.g. { "PS1": "psx" }.`);
      }
    }

    // Selectors are only mandatory for the generic selector adapter.
    if (adapterName === "selector" && source.requiresJavaScript !== true) {
      const selectors = source.selectors;
      if (!isObject(selectors)) {
        problems.push(`${location}.selectors is required for the "selector" adapter.`);
      } else {
        for (const requiredSelector of ["resultItem", "title", "pageLink", "downloadLink"]) {
          if (!isNonEmptyString(selectors[requiredSelector])) {
            const hint =
              requiredSelector === "downloadLink"
                ? ' If the site starts the download with JavaScript, set "requiresJavaScript": true instead (romkit will show the link for a manual download).'
                : "";
            problems.push(`${location}.selectors.${requiredSelector} is required.${hint}`);
          }
        }
        for (const optionalSelector of ["region", "size", "downloadLinkAttribute"]) {
          const value = selectors[optionalSelector];
          if (value != null && !isNonEmptyString(value)) problems.push(`${location}.selectors.${optionalSelector} must be a string or null.`);
        }
      }
    }
  });

  return sourcesByName;
}

function validateSystems(systems: unknown, sourcesByName: Map<string, JsonObject>, problems: string[]): void {
  if (!Array.isArray(systems)) {
    problems.push(`"systems" must be a list (it can be empty: []).`);
    return;
  }

  const seenIds = new Map<string, number>();
  // Every id and alias must point to a single system, or `-sys` would be ambiguous.
  const ownerByLookupName = new Map<string, string>();

  systems.forEach((system, systemIndex) => {
    const location = `systems[${systemIndex}]`;
    if (!isObject(system)) {
      problems.push(`${location} must be an object.`);
      return;
    }

    if (!isNonEmptyString(system.id) || !SYSTEM_ID_PATTERN.test(system.id)) {
      problems.push(`${location}.id is required and may only contain letters, digits, "-" and "_".`);
      return;
    }
    const systemId = system.id;
    const lowerId = systemId.toLowerCase();
    if (seenIds.has(lowerId)) problems.push(`${location}: duplicate system id "${systemId}".`);
    seenIds.set(lowerId, systemIndex);

    if (system.name !== undefined && !isNonEmptyString(system.name)) problems.push(`${location}.name must be a string.`);
    if (system.mode !== undefined && system.mode !== "standard" && system.mode !== "arcade") {
      problems.push(`${location}.mode must be "standard" or "arcade".`);
    }
    if (!isNonEmptyString(system.folder)) problems.push(`${location}.folder is required.`);

    const lookupNames = [systemId];
    if (system.aliases !== undefined) {
      if (!Array.isArray(system.aliases) || !system.aliases.every(isNonEmptyString)) {
        problems.push(`${location}.aliases must be a list of strings.`);
      } else {
        lookupNames.push(...system.aliases);
      }
    }
    for (const lookupName of lookupNames) {
      const key = compactKey(lookupName);
      const owner = ownerByLookupName.get(key);
      if (owner && owner !== systemId) {
        problems.push(`${location}: alias "${lookupName}" is also used by system "${owner}".`);
      }
      ownerByLookupName.set(key, systemId);
    }

    if (!Array.isArray(system.extensions) || system.extensions.length === 0) {
      problems.push(`${location}.extensions must be a non-empty list, e.g. [".gba"].`);
    } else {
      system.extensions.forEach((extension, extensionIndex) => {
        if (!isNonEmptyString(extension) || !extension.startsWith(".")) {
          problems.push(`${location}.extensions[${extensionIndex}] must start with ".", e.g. ".gba".`);
        }
      });
    }

    if (system.datPath !== undefined && system.datPath !== null && !isNonEmptyString(system.datPath)) {
      problems.push(`${location}.datPath must be a path or null.`);
    }
    validatePreferences(system.preferences, `${location}.preferences`, problems);
    if (system.compressToZip !== undefined && typeof system.compressToZip !== "boolean") {
      problems.push(`${location}.compressToZip must be true or false.`);
    }

    if (system.naming !== undefined) {
      if (!isObject(system.naming)) {
        problems.push(`${location}.naming must be an object.`);
      } else {
        const { template, keepTags } = system.naming;
        if (template !== undefined && (!isNonEmptyString(template) || !template.includes("{title}"))) {
          problems.push(`${location}.naming.template must contain {title}.`);
        }
        if (keepTags !== undefined && (!Array.isArray(keepTags) || !keepTags.every(isNonEmptyString))) {
          problems.push(`${location}.naming.keepTags must be a list of strings.`);
        }
      }
    }

    if (system.sources !== undefined) {
      if (!Array.isArray(system.sources) || !system.sources.every(isNonEmptyString)) {
        problems.push(`${location}.sources must be a list of source names.`);
      } else {
        for (const sourceName of system.sources) {
          const source = sourcesByName.get(sourceName.toLowerCase());
          if (!source) {
            problems.push(`${location}.sources: "${sourceName}" is not defined in the top-level "sources" list.`);
            continue;
          }
          // A source whose URL has {system} must say what to put there for this system.
          const searchUrl = typeof source.searchUrl === "string" ? source.searchUrl : "";
          const params = isObject(source.systemParams) ? source.systemParams : {};
          if (searchUrl.includes("{system}") && !isNonEmptyString(params[systemId])) {
            problems.push(`Source "${sourceName}" uses {system} in its searchUrl but has no systemParams entry for "${systemId}".`);
          }
        }
      }
    }
  });
}
