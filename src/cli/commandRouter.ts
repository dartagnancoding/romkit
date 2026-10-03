/**
 * Entry point of the CLI logic: parses arguments, validates which flags each
 * command accepts, loads the config and runs the command.
 */

import packageJson from "../../package.json";
import { loadConfig, locateConfigPath } from "../config/configLoader";
import { UsageError } from "../errors";
import { logger } from "../logging/logger";
import { FLAG_DEFINITIONS, getFlagDefinition, parseArguments, type FlagKey } from "./argumentParser";
import type { BasicCommandContext, CommandContext } from "./commandContext";
import { runAuditCommand } from "./commands/auditCommand";
import { runConfigCommand } from "./commands/configCommand";
import { runDownloadCommand } from "./commands/downloadCommand";
import { runImportCommand } from "./commands/importCommand";
import { runInboxCommand } from "./commands/inboxCommand";
import { runInitCommand } from "./commands/initCommand";
import { runOrganizeCommand } from "./commands/organizeCommand";
import { runQueueCommand } from "./commands/queueCommand";
import { runSourcesCommand } from "./commands/sourcesCommand";
import { runSystemsCommand } from "./commands/systemsCommand";
import { runVerifyCommand } from "./commands/verifyCommand";
import { Prompter } from "./prompts";
import { style } from "./terminalStyle";

interface CommandInfo {
  name: string;
  usage: string;
  summary: string;
  /** Flags this command accepts besides the global ones. */
  flags: FlagKey[];
}

type CommandDefinition = CommandInfo &
  ({ needsConfig: true; run: (context: CommandContext) => Promise<void> } | { needsConfig: false; run: (context: BasicCommandContext) => Promise<void> });

/** Accepted by every command. */
const GLOBAL_FLAGS: FlagKey[] = ["verbose", "config", "help"];

const COMMANDS: CommandDefinition[] = [
  {
    name: "download",
    usage: "romkit download <title> [-sys <system>] [--source <name>] [--refresh]",
    summary: "Search the system's sources, download, extract, rename and organize",
    flags: ["system", "source", "yes", "keepTemp", "refresh"],
    needsConfig: true,
    run: runDownloadCommand,
  },
  {
    name: "queue",
    usage: "romkit queue [list | add <title> [-sys <system>] | run | remove <n...|all>]",
    summary: "Line up downloads (and unfinished ones) and download them all, several at a time",
    flags: ["system", "source", "yes", "keepTemp", "refresh"],
    needsConfig: true,
    run: runQueueCommand,
  },
  {
    name: "import",
    usage: "romkit import <path> [-sys <system>] [--delete-source]",
    summary: "Extract, rename and organize a file you downloaded manually",
    flags: ["system", "yes", "keepTemp", "deleteSource"],
    needsConfig: true,
    run: runImportCommand,
  },
  {
    name: "inbox",
    usage: "romkit inbox [folder] [--dry-run] [--keep-source]",
    summary: "Organize everything in the inbox folder (default Downloads\\dump), detecting each console",
    flags: ["system", "dryRun", "yes", "keepTemp", "keepSource"],
    needsConfig: true,
    run: runInboxCommand,
  },
  {
    name: "organize",
    usage: "romkit organize -sys <system> [--dry-run]",
    summary: "Standardize the names of the files already in a system folder",
    flags: ["system", "dryRun", "yes"],
    needsConfig: true,
    run: runOrganizeCommand,
  },
  {
    name: "audit",
    usage: "romkit audit [folder] [-sys <system>]",
    summary: "Read-only report: duplicates, non-standard names, unverified files, stray files",
    flags: ["system"],
    needsConfig: true,
    run: runAuditCommand,
  },
  {
    name: "verify",
    usage: "romkit verify -sys <system>",
    summary: "Check a system folder against its DAT and list files that are not known good dumps",
    flags: ["system"],
    needsConfig: true,
    run: runVerifyCommand,
  },
  {
    name: "systems",
    usage: "romkit systems [list | add [name] | remove <id>]",
    summary: "List, add or remove configured systems",
    flags: [],
    needsConfig: true,
    run: runSystemsCommand,
  },
  {
    name: "sources",
    usage: "romkit sources [list | export <file> [-sys <system>] | import <file or link>]",
    summary: "List, export or import download sources (to share them or set up another PC)",
    flags: ["system", "yes"],
    needsConfig: false,
    run: runSourcesCommand,
  },
  {
    name: "config",
    usage: "romkit config [<setting> [<value>] | open | path]",
    summary: "Show and change settings: folders, 7-Zip, downloader, preferred regions",
    flags: [],
    needsConfig: false,
    run: runConfigCommand,
  },
  {
    name: "init",
    usage: "romkit init",
    summary: "Create the config file (folders, 7-Zip, aria2c, sources)",
    flags: [],
    needsConfig: false,
    run: runInitCommand,
  },
];

/** Runs the CLI and returns the process exit code. */
export async function runCli(argumentList: string[]): Promise<number> {
  const args = parseArguments(argumentList);
  logger.configure({ verbose: args.flags.verbose });

  if (args.flags.version) {
    console.log(`romkit ${packageJson.version}`);
    return 0;
  }

  const commandName = args.positionals[0]?.toLowerCase();
  if (!commandName || commandName === "help") {
    printGeneralHelp(args.positionals[1]?.toLowerCase());
    return 0;
  }

  const command = COMMANDS.find((candidate) => candidate.name === commandName);
  if (!command) {
    throw new UsageError(`Unknown command "${args.positionals[0]}".`, "Run `romkit --help` to see the available commands.");
  }
  if (args.flags.help) {
    printCommandHelp(command);
    return 0;
  }

  const acceptedFlags = new Set([...GLOBAL_FLAGS, ...command.flags]);
  for (const providedFlag of args.providedFlags) {
    if (!acceptedFlags.has(providedFlag)) {
      const spelling = getFlagDefinition(providedFlag).spellings.find((candidate) => candidate.startsWith("--")) ?? providedFlag;
      throw new UsageError(`"${command.name}" does not accept ${spelling}.`, `Usage: ${command.usage}`);
    }
  }

  const configPath = locateConfigPath(args.flags.config);
  const prompter = new Prompter();
  try {
    if (command.needsConfig) {
      // Only `download` and `queue` use the sources; other commands tolerate problems there.
      const config = await loadConfig(configPath, { requireValidSources: command.name === "download" || command.name === "queue" });
      logger.configure({ logFilePath: config.logFile });
      logger.fileOnly(`romkit ${packageJson.version}: ${argumentList.join(" ")}`, "info");
      logger.debug(`Config: ${configPath}`);
      await command.run({ args, configPath, prompter, config });
    } else {
      logger.fileOnly(`romkit ${packageJson.version}: ${argumentList.join(" ")}`, "info");
      await command.run({ args, configPath, prompter });
    }
  } finally {
    prompter.close();
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

function printGeneralHelp(topic: string | undefined): void {
  const topicCommand = topic ? COMMANDS.find((candidate) => candidate.name === topic) : undefined;
  if (topicCommand) {
    printCommandHelp(topicCommand);
    return;
  }

  console.log(`${style.bold("romkit")} ${packageJson.version}: download, extract, rename and organize ROMs\n`);
  console.log(style.bold("Commands:"));
  for (const command of COMMANDS) {
    console.log(`  ${style.cyan(command.name.padEnd(10))} ${command.summary}`);
  }
  console.log(`\n${style.bold("Examples:")}`);
  console.log("  romkit download mega man zero 4 -sys gba");
  console.log("  romkit queue add crash bandicoot 2 -sys ps1    # then: romkit queue run");
  console.log('  romkit import "$HOME\\Downloads\\game.zip" -sys gba');
  console.log("  romkit inbox                     # organize everything in Downloads\\dump");
  console.log("  romkit organize -sys gba --dry-run");
  console.log("  romkit systems add playstation");
  console.log("  romkit config libraryRoot D:\\Games");
  console.log("  romkit sources import https://example.com/my-sources.json");
  console.log(`\nRun ${style.cyan("romkit <command> --help")} for the options of a command.`);
}

function printCommandHelp(command: CommandDefinition): void {
  console.log(`${style.bold(command.usage)}\n`);
  console.log(`${command.summary}.\n`);
  console.log(style.bold("Options:"));
  const flagKeys = [...command.flags, ...GLOBAL_FLAGS];
  for (const definition of FLAG_DEFINITIONS.filter((candidate) => flagKeys.includes(candidate.key))) {
    const spellings = definition.spellings.join(", ") + (definition.takesValue ? ` <${definition.valueName}>` : "");
    console.log(`  ${style.cyan(spellings.padEnd(36))} ${definition.description}`);
  }
}
