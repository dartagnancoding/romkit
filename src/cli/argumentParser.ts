/**
 * Command line parser.
 *
 * Hand-written (no library) because the CLI uses a non-standard spelling:
 * `-sys GBA` is a single-dash flag with a multi-letter name, which most parsers
 * would read as `-s -y -s`. Here every accepted spelling is listed explicitly,
 * so there is no flag bundling (`-nv` is NOT `-n -v`).
 *
 * Flag spellings are matched case-insensitively (`-Sys` works too, which feels
 * natural in PowerShell).
 */

import { UsageError } from "../errors";

export type FlagKey =
  | "system"
  | "config"
  | "source"
  | "dryRun"
  | "verbose"
  | "yes"
  | "keepTemp"
  | "refresh"
  | "deleteSource"
  | "keepSource"
  | "help"
  | "version";

export interface FlagDefinition {
  key: FlagKey;
  spellings: string[];
  takesValue: boolean;
  /** Placeholder shown in help, e.g. `--config <path>`. */
  valueName?: string;
  description: string;
}

export const FLAG_DEFINITIONS: FlagDefinition[] = [
  {
    key: "system",
    spellings: ["-sys", "--sys", "-s", "--system"],
    takesValue: true,
    valueName: "system",
    description: 'System id or alias (e.g. GBA, "game boy advance")',
  },
  { key: "dryRun", spellings: ["--dry-run", "-n"], takesValue: false, description: "Show what would change without changing anything" },
  { key: "yes", spellings: ["--yes", "-y"], takesValue: false, description: "Accept every name suggestion without asking; conflicts are skipped" },
  { key: "source", spellings: ["--source"], takesValue: true, valueName: "name", description: "Search only this source" },
  { key: "keepTemp", spellings: ["--keep-temp"], takesValue: false, description: "Keep the temporary folder (for debugging)" },
  {
    key: "refresh",
    spellings: ["--refresh"],
    takesValue: false,
    description: "download: fetch list pages again instead of using the copies saved in the last 7 days",
  },
  {
    key: "deleteSource",
    spellings: ["--delete-source"],
    takesValue: false,
    description: "import: delete the original file after a successful import",
  },
  {
    key: "keepSource",
    spellings: ["--keep-source"],
    takesValue: false,
    description: "inbox: copy files instead of moving them out of the inbox",
  },
  { key: "config", spellings: ["--config"], takesValue: true, valueName: "path", description: "Use this config file" },
  { key: "verbose", spellings: ["--verbose", "-v"], takesValue: false, description: "Print detailed progress" },
  { key: "help", spellings: ["--help", "-h"], takesValue: false, description: "Show help" },
  { key: "version", spellings: ["--version"], takesValue: false, description: "Show version" },
];

export interface ParsedFlags {
  system?: string;
  config?: string;
  source?: string;
  dryRun: boolean;
  verbose: boolean;
  yes: boolean;
  keepTemp: boolean;
  refresh: boolean;
  deleteSource: boolean;
  keepSource: boolean;
  help: boolean;
  version: boolean;
}

export interface ParsedArguments {
  /** Everything that is not a flag, in order: command, subcommand, title words... */
  positionals: string[];
  flags: ParsedFlags;
  /** Which flags were actually typed, so commands can reject flags they do not support. */
  providedFlags: Set<FlagKey>;
}

/** Lowercased spelling → definition, built once. */
const definitionsBySpelling = new Map<string, FlagDefinition>(
  FLAG_DEFINITIONS.flatMap((definition) => definition.spellings.map((spelling) => [spelling.toLowerCase(), definition] as const)),
);

export function parseArguments(argumentList: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const providedFlags = new Set<FlagKey>();
  const flags: ParsedFlags = {
    dryRun: false,
    verbose: false,
    yes: false,
    keepTemp: false,
    refresh: false,
    deleteSource: false,
    keepSource: false,
    help: false,
    version: false,
  };

  let tokenIndex = 0;
  let flagsEnded = false;

  while (tokenIndex < argumentList.length) {
    const token = argumentList[tokenIndex]!;
    tokenIndex++;

    // "--" ends flag parsing, so a title starting with "-" can still be passed.
    if (!flagsEnded && token === "--") {
      flagsEnded = true;
      continue;
    }
    if (flagsEnded || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    // Support both "--config path" and "--config=path".
    const equalsPosition = token.indexOf("=");
    const spelling = equalsPosition === -1 ? token : token.slice(0, equalsPosition);
    const inlineValue = equalsPosition === -1 ? undefined : token.slice(equalsPosition + 1);

    const definition = definitionsBySpelling.get(spelling.toLowerCase());
    if (!definition) {
      throw new UsageError(`Unknown option "${spelling}".`, "Run `romkit --help` to see the available options.");
    }
    providedFlags.add(definition.key);

    if (!definition.takesValue) {
      if (inlineValue !== undefined) {
        throw new UsageError(`Option "${spelling}" does not take a value.`);
      }
      setBooleanFlag(flags, definition.key);
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const nextToken = argumentList[tokenIndex];
      if (nextToken === undefined || (nextToken.startsWith("-") && nextToken.length > 1)) {
        throw new UsageError(`Option "${spelling}" needs a value: ${spelling} <${definition.valueName ?? "value"}>.`);
      }
      value = nextToken;
      tokenIndex++;
    }
    if (value.trim() === "") {
      throw new UsageError(`Option "${spelling}" needs a non-empty value.`);
    }
    setStringFlag(flags, definition.key, value.trim());
  }

  return { positionals, flags, providedFlags };
}

function setBooleanFlag(flags: ParsedFlags, key: FlagKey): void {
  switch (key) {
    case "dryRun":
    case "verbose":
    case "yes":
    case "keepTemp":
    case "refresh":
    case "deleteSource":
    case "keepSource":
    case "help":
    case "version":
      flags[key] = true;
      return;
    default:
      throw new Error(`Flag ${key} is not a boolean flag.`);
  }
}

function setStringFlag(flags: ParsedFlags, key: FlagKey, value: string): void {
  switch (key) {
    case "system":
    case "config":
    case "source":
      flags[key] = value;
      return;
    default:
      throw new Error(`Flag ${key} does not take a value.`);
  }
}

export function getFlagDefinition(key: FlagKey): FlagDefinition {
  const definition = FLAG_DEFINITIONS.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`Unknown flag key ${key}`);
  return definition;
}
