/**
 * Makes a string safe to use as a Windows file name (without extension).
 */

import { RomkitError } from "../errors";

/** Device names Windows reserves; "CON.gba" cannot be created. */
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Leaves room for the folder path and extension within the classic 260-char path limit. */
const MAX_BASE_NAME_LENGTH = 180;

export function sanitizeFileName(rawName: string): string {
  let name = rawName.normalize("NFC");

  // "Zelda: The Minish Cap" → "Zelda - The Minish Cap" (the same convention No-Intro uses).
  name = name.replace(/\s*:\s*/g, " - ");
  name = name.replace(/[\\/]/g, "-");
  name = name.replace(/"/g, "'");
  name = name.replace(/[<>|?*]/g, "");
  // Control characters (tabs, line breaks...) are invalid too; turn them into spaces.
  name = name.replace(/[\u0000-\u001f\u007f]/g, " ");
  name = name.replace(/\s+/g, " ").trim();

  if (name.length > MAX_BASE_NAME_LENGTH) {
    name = name.slice(0, MAX_BASE_NAME_LENGTH).trimEnd();
  }
  // Windows silently drops trailing dots and spaces, which would make the file
  // name differ from what we think it is.
  name = name.replace(/[. ]+$/, "");

  if (name === "") {
    throw new RomkitError(`"${rawName}" does not contain any character valid in a file name.`);
  }
  if (RESERVED_WINDOWS_NAMES.test(name)) {
    name = `${name}_`;
  }
  return name;
}
