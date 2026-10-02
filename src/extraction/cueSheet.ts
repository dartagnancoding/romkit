/**
 * Reads and rewrites the FILE lines of .cue sheets.
 *
 * A cue sheet describes a CD image and lists its track files:
 *     FILE "Game (USA) (Track 1).bin" BINARY
 *       TRACK 01 MODE2/2352
 *         INDEX 01 00:00:00
 * When the .bin files are renamed, these FILE lines must be updated or the
 * emulator will not find the tracks.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileStem } from "../util/fileSystem";

/**
 * One FILE line. Groups: 1 indentation, 2 quoted name, 3 unquoted name,
 * 4 file type (BINARY, WAVE...), 5 trailing spaces and optional "\r"
 * (kept so Windows line endings survive the rewrite).
 */
const FILE_LINE_PATTERN = /^([ \t]*)FILE[ \t]+(?:"([^"]*)"|(\S+))[ \t]+(\S+)([ \t]*\r?)$/gim;

/**
 * Writes a minimal single-track cue sheet for a .bin that came without one
 * (common for single-track PS1 games). The cue is created in `cueDirectory`;
 * when that is not the .bin's folder, it references the .bin by absolute path
 * (it is rewritten to a plain file name when placed in the library).
 */
export async function writeCueForBin(binPath: string, cueDirectory: string, trackMode: string): Promise<string> {
  const cuePath = join(cueDirectory, `${fileStem(binPath)}.cue`);
  const reference = resolve(dirname(binPath)) === resolve(cueDirectory) ? basename(binPath) : resolve(binPath);
  const cueText = [`FILE "${reference}" BINARY`, `  TRACK 01 ${trackMode}`, "    INDEX 01 00:00:00", ""].join("\r\n");
  await writeFile(cuePath, cueText, "utf8");
  return cuePath;
}

/** Reads a cue sheet. Old cue files are often ANSI (Windows-1252), not UTF-8. */
export async function readCueSheet(cuePath: string): Promise<string> {
  const bytes = await readFile(cuePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

/** Returns the file names referenced by FILE lines, in order, exactly as written. */
export function parseCueFileReferences(cueText: string): string[] {
  const references: string[] = [];
  for (const match of cueText.matchAll(FILE_LINE_PATTERN)) {
    const reference = match[2] ?? match[3];
    if (reference) references.push(reference);
  }
  return references;
}

/**
 * Replaces referenced file names. `replacements` maps the reference as written in
 * the cue (see parseCueFileReferences) to the new file name.
 */
export function rewriteCueFileReferences(cueText: string, replacements: Map<string, string>): string {
  return cueText.replace(
    FILE_LINE_PATTERN,
    (fullLine, indentation: string, quotedName: string | undefined, bareName: string | undefined, fileType: string, trailing: string) => {
      const reference = quotedName ?? bareName ?? "";
      const replacement = replacements.get(reference);
      if (replacement === undefined) return fullLine;
      return `${indentation}FILE "${replacement}" ${fileType}${trailing}`;
    },
  );
}
