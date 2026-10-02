/**
 * Finds a configured system from what the user typed (id, name or alias).
 * Comparison ignores case, spaces and punctuation: "Game Boy Advance",
 * "gameboy-advance" and "GBA" can all point to the same system.
 */

import type { Prompter } from "../cli/prompts";
import { RomkitError } from "../errors";
import { compactKey } from "../naming/titleNormalization";
import type { ResolvedConfig, ResolvedSystem } from "./configTypes";

export function findSystem(config: ResolvedConfig, query: string): ResolvedSystem | null {
  const queryKey = compactKey(query);
  return (
    config.systems.find((system) => [system.id, system.name, ...system.aliases].some((name) => compactKey(name) === queryKey)) ??
    null
  );
}

export function requireSystem(config: ResolvedConfig, query: string): ResolvedSystem {
  const system = findSystem(config, query);
  if (system) return system;
  const configuredIds = config.systems.map((candidate) => candidate.id).join(", ") || "(none)";
  throw new RomkitError(`Unknown system "${query}". Configured systems: ${configuredIds}.`, "Add one with `romkit systems add`.");
}

/** Uses the -sys value when given; otherwise asks the user to pick from the configured systems. */
export async function resolveSystemFromFlagOrPrompt(
  config: ResolvedConfig,
  flagValue: string | undefined,
  prompter: Prompter,
): Promise<ResolvedSystem> {
  if (flagValue) return requireSystem(config, flagValue);

  if (config.systems.length === 0) {
    throw new RomkitError("No systems are configured yet.", "Add one with `romkit systems add`.");
  }
  const chosenIndex = await prompter.chooseFromList(
    "Which system?",
    config.systems.map((system) => `${system.id.padEnd(8)} ${system.name}`),
  );
  if (chosenIndex === null) throw new RomkitError("No system chosen.");
  return config.systems[chosenIndex]!;
}
