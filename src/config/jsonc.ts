/**
 * "JSON with comments" support for files edited by hand (config and aliases).
 *
 * Accepts `// line comments`, `/* block comments *\/` and trailing commas
 * (`[1, 2,]`), then hands plain JSON to JSON.parse. Text inside strings is never
 * touched, so URLs like "https://..." keep their "//".
 */

import { RomkitError } from "../errors";

/** Removes comments and trailing commas outside of strings. Line breaks are kept so line numbers stay correct. */
export function stripJsonComments(text: string): string {
  let output = "";
  let position = 0;
  let insideString = false;

  while (position < text.length) {
    const character = text[position]!;
    const nextCharacter = text[position + 1];

    if (insideString) {
      output += character;
      if (character === "\\") {
        // Copy the escaped character as-is (it may be a quote).
        output += nextCharacter ?? "";
        position += 2;
        continue;
      }
      if (character === '"') insideString = false;
      position++;
      continue;
    }

    if (character === '"') {
      insideString = true;
      output += character;
      position++;
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      // Skip to the end of the line, keeping the line break itself.
      while (position < text.length && text[position] !== "\n") position++;
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      position += 2;
      while (position < text.length && !(text[position] === "*" && text[position + 1] === "/")) {
        // Keep line breaks so error line numbers still match the original file.
        if (text[position] === "\n") output += "\n";
        position++;
      }
      position += 2;
      continue;
    }

    output += character;
    position++;
  }

  return removeTrailingCommas(output);
}

/** Drops a comma that is followed (after whitespace) by } or ], outside of strings. */
function removeTrailingCommas(text: string): string {
  let output = "";
  let insideString = false;
  for (let position = 0; position < text.length; position++) {
    const character = text[position]!;
    if (insideString) {
      output += character;
      if (character === "\\") {
        output += text[position + 1] ?? "";
        position++;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }
    if (character === '"') insideString = true;
    if (character === ",") {
      const followingText = text.slice(position + 1).trimStart();
      if (followingText.startsWith("}") || followingText.startsWith("]")) continue;
    }
    output += character;
  }
  return output;
}

/**
 * Parses JSON-with-comments. On a syntax error, reports the line and column and
 * shows that line, which is much easier to fix than a bare "Unrecognized token".
 */
export function parseJsonWithComments(text: string, filePath: string): unknown {
  const withoutBom = text.replace(/^﻿/, "");
  const plainJson = stripJsonComments(withoutBom);
  try {
    return JSON.parse(plainJson);
  } catch (error) {
    const location = locateSyntaxError(plainJson);
    const lineHint = location ? ` (line ${location.line}, column ${location.column})` : "";
    const lineText = location ? `\n  ${location.line} | ${withoutBom.split(/\r?\n/)[location.line - 1]?.trim() ?? ""}` : "";
    throw new RomkitError(
      `${filePath} is not valid JSON${lineHint}: ${(error as Error).message}${lineText}`,
      "Common causes: a missing comma between items, a missing quote, or a backslash in a path that is not doubled (use \\\\ or /).",
    );
  }
}

/**
 * Bun's JSON.parse messages carry no position ("Expected '}'"), so this small
 * validator walks the JSON the same way a parser would and returns where the
 * first problem is. It only locates errors; JSON.parse still does the parsing.
 */
export function locateSyntaxError(text: string): { line: number; column: number } | null {
  let position = 0;

  const fail = (): never => {
    throw position;
  };
  const skipWhitespace = () => {
    while (position < text.length && /\s/.test(text[position]!)) position++;
  };
  const expect = (character: string) => {
    skipWhitespace();
    if (text[position] !== character) fail();
    position++;
  };

  const parseString = () => {
    expect('"');
    while (position < text.length && text[position] !== '"') {
      if (text[position] === "\n") fail();
      position += text[position] === "\\" ? 2 : 1;
    }
    if (position >= text.length) fail();
    position++;
  };

  const parseValue = (): void => {
    skipWhitespace();
    const character = text[position];
    if (character === "{") {
      position++;
      skipWhitespace();
      if (text[position] === "}") {
        position++;
        return;
      }
      while (true) {
        parseString();
        expect(":");
        parseValue();
        skipWhitespace();
        if (text[position] === ",") {
          position++;
          continue;
        }
        expect("}");
        return;
      }
    }
    if (character === "[") {
      position++;
      skipWhitespace();
      if (text[position] === "]") {
        position++;
        return;
      }
      while (true) {
        parseValue();
        skipWhitespace();
        if (text[position] === ",") {
          position++;
          continue;
        }
        expect("]");
        return;
      }
    }
    if (character === '"') return parseString();
    const literal = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(position));
    if (!literal) fail();
    position += literal![0].length;
  };

  try {
    parseValue();
    skipWhitespace();
    if (position < text.length) fail();
    return null;
  } catch (failedPosition) {
    if (typeof failedPosition !== "number") throw failedPosition;
    const lines = text.slice(0, failedPosition).split("\n");
    return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
  }
}
