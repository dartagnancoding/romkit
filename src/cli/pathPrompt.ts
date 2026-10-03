/**
 * Asks for a folder or file path: typed, pasted, or chosen in the Windows dialog.
 */

import { canPickWithDialog, pickFile, pickFolder } from "./filePicker";
import type { Prompter } from "./prompts";
import { style } from "./terminalStyle";

export interface PathQuestion {
  question: string;
  kind: "folder" | "file";
  /** Returned on an empty answer. */
  defaultValue?: string;
  /** File dialog filter, e.g. "7-Zip|7z.exe". */
  filter?: string;
}

/** Answer that opens the dialog. */
const DIALOG_ANSWER = "e";

export async function askForPath(prompter: Prompter, pathQuestion: PathQuestion): Promise<string> {
  const dialogAvailable = canPickWithDialog();
  const hints = [
    pathQuestion.defaultValue ? "Enter keeps it" : "type or paste a path",
    dialogAvailable ? `"${DIALOG_ANSWER}" opens Explorer` : null,
  ].filter(Boolean);

  while (true) {
    const answer = unquote(await prompter.ask(`${pathQuestion.question} ${style.dim(`(${hints.join(", ")})`)}`, pathQuestion.defaultValue));
    if (dialogAvailable && answer.toLowerCase() === DIALOG_ANSWER) {
      const chosenPath =
        pathQuestion.kind === "folder"
          ? await pickFolder(pathQuestion.question, pathQuestion.defaultValue)
          : await pickFile({ title: pathQuestion.question, filter: pathQuestion.filter, initialPath: pathQuestion.defaultValue });
      if (chosenPath) {
        console.log(style.dim(`  → ${chosenPath}`));
        return chosenPath;
      }
      console.log(style.yellow("Nothing chosen."));
      continue;
    }
    if (answer !== "") return answer;
  }
}

/** Explorer's "Copy as path" wraps the path in quotes: "C:\Games\ROM" → C:\Games\ROM */
export function unquote(text: string): string {
  const trimmed = text.trim();
  return /^".*"$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}
