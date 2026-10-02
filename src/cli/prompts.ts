/**
 * Interactive questions in the terminal (readline based, no dependencies).
 *
 * One Prompter is created per run and closed at the end; otherwise the open
 * readline interface keeps the process alive.
 */

import { createInterface, type Interface } from "node:readline";
import { UserCancelledError } from "../errors";
import { style } from "./terminalStyle";

export interface ChoiceKey<Key extends string> {
  key: Key;
  /** Single letter the user types, e.g. "o" for overwrite. */
  letter: string;
  label: string;
}

interface PendingQuestion {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
}

export class Prompter {
  private readlineInterface: Interface | null = null;
  private inputClosed = false;
  /**
   * Lines typed (or piped) before a question was asked. When input is piped,
   * e.g. `"1`nk" | romkit ...`, readline reads every line at once; queueing them
   * makes each one answer the next question instead of being lost.
   */
  private readonly bufferedLines: string[] = [];
  private readonly pendingQuestions: PendingQuestion[] = [];

  private getInterface(): Interface {
    if (!this.readlineInterface) {
      const readlineInterface = createInterface({ input: process.stdin, output: process.stdout });
      readlineInterface.on("line", (line) => {
        const pendingQuestion = this.pendingQuestions.shift();
        if (pendingQuestion) pendingQuestion.resolve(line);
        else this.bufferedLines.push(line);
      });
      readlineInterface.on("close", () => {
        this.inputClosed = true;
        for (const pendingQuestion of this.pendingQuestions.splice(0)) pendingQuestion.reject(new UserCancelledError());
      });
      // Without a SIGINT listener readline only pauses on Ctrl+C and the pending
      // question would wait forever; closing turns it into a cancellation.
      readlineInterface.on("SIGINT", () => readlineInterface.close());
      this.readlineInterface = readlineInterface;
    }
    return this.readlineInterface;
  }

  /** Free-text question. An empty answer returns the default (when given). */
  async ask(question: string, defaultValue?: string): Promise<string> {
    const readlineInterface = this.getInterface();
    const defaultSuffix = defaultValue ? style.dim(` [${defaultValue}]`) : "";
    readlineInterface.setPrompt(`${question}${defaultSuffix} `);
    readlineInterface.prompt();

    let answer: string;
    const bufferedLine = this.bufferedLines.shift();
    if (bufferedLine !== undefined) {
      answer = bufferedLine;
      // A terminal echoes what the user types; piped input is not echoed, so show it.
      if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`);
    } else {
      if (this.inputClosed) throw new UserCancelledError();
      answer = await new Promise<string>((resolve, reject) => this.pendingQuestions.push({ resolve, reject }));
      if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`);
    }

    const trimmedAnswer = answer.trim();
    return trimmedAnswer === "" && defaultValue !== undefined ? defaultValue : trimmedAnswer;
  }

  /** Yes/no question. Enter picks the default. */
  async confirm(question: string, defaultAnswer: boolean): Promise<boolean> {
    const hint = defaultAnswer ? "(Y/n)" : "(y/N)";
    while (true) {
      const answer = (await this.ask(`${question} ${style.dim(hint)}`)).toLowerCase();
      if (answer === "") return defaultAnswer;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      console.log(style.yellow("Please answer y or n."));
    }
  }

  /**
   * Shows a numbered list and returns the chosen zero-based index,
   * or null when the user picks 0 (cancel).
   */
  async chooseFromList(heading: string, itemLabels: string[]): Promise<number | null> {
    console.log(heading);
    itemLabels.forEach((label, itemIndex) => {
      console.log(`  ${style.cyan(String(itemIndex + 1).padStart(2))}) ${label}`);
    });
    console.log(`  ${style.cyan(" 0")}) Cancel`);

    while (true) {
      const answer = await this.ask(`Choose [1-${itemLabels.length}, 0 to cancel]:`);
      const chosenNumber = Number.parseInt(answer, 10);
      if (String(chosenNumber) === answer && chosenNumber >= 0 && chosenNumber <= itemLabels.length) {
        return chosenNumber === 0 ? null : chosenNumber - 1;
      }
      console.log(style.yellow(`Type a number between 0 and ${itemLabels.length}.`));
    }
  }

  /** Asks the user to pick one action by its letter, e.g. [o]verwrite / [s]kip. */
  async chooseKey<Key extends string>(question: string, choices: ChoiceKey<Key>[]): Promise<Key> {
    const legend = choices.map((choice) => `${style.cyan(`[${choice.letter}]`)} ${choice.label}`).join("  ");
    while (true) {
      const answer = (await this.ask(`${question} ${legend}:`)).toLowerCase();
      const matchedChoice = choices.find((choice) => choice.letter === answer);
      if (matchedChoice) return matchedChoice.key;
      console.log(style.yellow(`Type one of: ${choices.map((choice) => choice.letter).join(", ")}.`));
    }
  }

  close(): void {
    this.readlineInterface?.close();
    this.readlineInterface = null;
  }
}
