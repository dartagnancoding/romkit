/**
 * Shows a name suggestion and, when confidence is low, lets the user accept it,
 * pick an alternative, type a name or skip.
 */

import type { ResolvedSystem } from "../config/configTypes";
import type { IdentificationCandidate, IdentificationResult } from "../identification/romIdentifier";
import { logger } from "../logging/logger";
import { sanitizeFileName } from "../naming/filenameSanitizer";
import { formatRomBaseName } from "../naming/nameFormatter";
import { formatPercent } from "../util/format";
import type { Prompter } from "./prompts";
import { style } from "./terminalStyle";

export interface NameConfirmationOptions {
  /** Original file name, shown for context. */
  originalName: string;
  autoAcceptThreshold: number;
  /** --yes: accept the suggestion even when confidence is low. */
  assumeYes: boolean;
}

export function describeIdentification(result: IdentificationResult): string {
  return `${result.method}, ${formatPercent(result.confidence)} confidence: ${result.explanation}`;
}

/** Returns the final base name, or null when the user chose to skip this file. */
export async function confirmRomName(
  result: IdentificationResult,
  system: ResolvedSystem,
  prompter: Prompter,
  options: NameConfirmationOptions,
): Promise<string | null> {
  const formatCandidate = (candidate: IdentificationCandidate) => formatRomBaseName(candidate, system.naming, system.id);
  const suggestedName = formatCandidate(result);

  if (result.confidence >= options.autoAcceptThreshold || options.assumeYes) {
    logger.info(`Name: ${style.cyan(suggestedName)} ${style.dim(`(${describeIdentification(result)})`)}`);
    return suggestedName;
  }

  // Alternatives that format to the same name as the suggestion add nothing.
  const alternativeNames = [...new Set(result.alternatives.map(formatCandidate))].filter((name) => name !== suggestedName);

  console.log("");
  console.log(`${style.yellow("Low confidence")} for ${style.bold(options.originalName)}`);
  console.log(`  Suggested: ${style.cyan(suggestedName)} ${style.dim(`(${describeIdentification(result)})`)}`);
  alternativeNames.forEach((alternativeName, alternativeIndex) => {
    console.log(`  ${style.cyan(String(alternativeIndex + 1))}) ${alternativeName}`);
  });

  const alternativesHint = alternativeNames.length > 0 ? `1-${alternativeNames.length} = alternative, ` : "";
  while (true) {
    const answer = await prompter.ask(`Enter = accept, ${alternativesHint}e = type a name, s = skip:`);
    const lowerAnswer = answer.toLowerCase();

    if (answer === "") return suggestedName;
    if (lowerAnswer === "s") return null;
    if (lowerAnswer === "e") {
      const typedName = await prompter.ask("New name (without extension):");
      if (typedName === "") continue;
      try {
        // A typed name is used as-is (only made Windows-safe): no template, no tag removal.
        return sanitizeFileName(typedName);
      } catch (error) {
        console.log(style.yellow((error as Error).message));
        continue;
      }
    }
    const alternativeNumber = Number.parseInt(answer, 10);
    if (String(alternativeNumber) === answer && alternativeNumber >= 1 && alternativeNumber <= alternativeNames.length) {
      return alternativeNames[alternativeNumber - 1]!;
    }
    console.log(style.yellow("Not a valid option."));
  }
}
