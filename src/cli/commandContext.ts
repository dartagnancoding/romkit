/** What every command receives from the router. */

import type { ResolvedConfig } from "../config/configTypes";
import type { ParsedArguments } from "./argumentParser";
import type { Prompter } from "./prompts";

export interface BasicCommandContext {
  args: ParsedArguments;
  /** Where the config file is (or will be created, for `init`). */
  configPath: string;
  prompter: Prompter;
}

export interface CommandContext extends BasicCommandContext {
  config: ResolvedConfig;
}
