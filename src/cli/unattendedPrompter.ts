/**
 * A Prompter for work that runs without anyone watching (`romkit queue run`):
 * any question becomes a NeedsDecisionError, so the caller can set the file
 * aside (in the inbox) instead of blocking every other download on it.
 */

import { RomkitError } from "../errors";
import { type ChoiceKey, Prompter } from "./prompts";

export class NeedsDecisionError extends RomkitError {
  constructor(readonly question: string) {
    super(`needs a decision: ${question}`);
  }
}

export class UnattendedPrompter extends Prompter {
  override async ask(question: string, _defaultValue?: string): Promise<string> {
    throw new NeedsDecisionError(question);
  }

  override async confirm(question: string, _defaultAnswer: boolean): Promise<boolean> {
    throw new NeedsDecisionError(question);
  }

  override async chooseFromList(heading: string, _itemLabels: string[]): Promise<number | null> {
    throw new NeedsDecisionError(heading);
  }

  override async chooseKey<Key extends string>(question: string, _choices: ChoiceKey<Key>[]): Promise<Key> {
    throw new NeedsDecisionError(question);
  }
}
