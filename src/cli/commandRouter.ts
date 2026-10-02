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
import { runDownloadCommand } from "./commands/downloadCommand";
import { runImportCommand } from "./commands/importCommand";
import { runInitCommand } from "./commands/initCommand";
import { runOrganizeCommand } from "./commands/organizeCommand";
import { runSystemsCommand } from "./commands/systemsCommand";
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
    usage: "romkit download <title> [-sys <system>] [--source <name>]",
    summary: "Search the system's sources, download, extract, rename and organize",
    flags: ["system", "source", "yes", "keepTemp"],
    needsConfig: true,
    run: runDownloadCommand,
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
    name: "organize",
    usage: "romkit organize -sys <system> [--dry-run]",
    summary: "Standardize the names of the files already in a system folder",
    flags: ["system", "dryRun", "yes"],
    needsConfig: true,
    run: runOrganizeCommand,
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
    name: "init",
    usage: "romkit init",
    summary: "Create the config file",
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
      const config = await loadConfig(configPath);
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
  console.log('  romkit import "$HOME\\Downloads\\game.zip" -sys gba');
  console.log("  romkit organize -sys gba --dry-run");
  console.log("  romkit systems add playstation");
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
