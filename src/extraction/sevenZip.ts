/**
 * Runs the configured 7z.exe to extract archives (zip/rar/7z) and to create zips
 * for systems with compressToZip.
 */

import { RomkitError } from "../errors";
import { logger } from "../logging/logger";
import { pathExists } from "../util/fileSystem";

export async function ensureSevenZipAvailable(sevenZipPath: string): Promise<void> {
  if (!(await pathExists(sevenZipPath))) {
    throw new RomkitError(
      `7-Zip was not found at ${sevenZipPath}.`,
      'Install 7-Zip (https://www.7-zip.org) or fix "sevenZipPath" in the config.',
    );
  }
}

export async function extractArchive(sevenZipPath: string, archivePath: string, outputDirectory: string): Promise<void> {
  await runSevenZip(sevenZipPath, [
    "x", // extract keeping folder structure
    `-o${outputDirectory}`,
    "-y", // answer yes to overwrite questions
    // Empty password: a protected archive fails right away instead of 7-Zip
    // waiting for a password on the keyboard.
    "-p",
    "--", // nothing after this is a switch, even if a file name starts with "-"
    archivePath,
  ]);
}

export async function createZipArchive(sevenZipPath: string, zipPath: string, filePaths: string[]): Promise<void> {
  await runSevenZip(sevenZipPath, ["a", "-tzip", "-mx=9", "--", zipPath, ...filePaths]);
}

export interface ArchiveEntry {
  /** Path inside the archive, e.g. "Disc 1/game.iso". */
  path: string;
  size: number;
}

/** Lists the files inside an archive without extracting anything. */
export async function listArchiveEntries(sevenZipPath: string, archivePath: string): Promise<ArchiveEntry[]> {
  // -slt prints one "Key = value" block per entry; -ba drops the headers around the list.
  const listProcess = Bun.spawn([sevenZipPath, "l", "-slt", "-ba", "-p", "--", archivePath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, listing] = await Promise.all([listProcess.exited, new Response(listProcess.stdout).text()]);
  if (exitCode !== 0) {
    throw new RomkitError(`7-Zip could not list ${archivePath} (exit code ${exitCode}).`);
  }

  const entries: ArchiveEntry[] = [];
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const separatorIndex = line.indexOf(" = ");
      if (separatorIndex > 0) fields.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 3));
    }
    const entryPath = fields.get("Path");
    if (!entryPath || fields.get("Folder") === "+") continue;
    entries.push({ path: entryPath, size: Number(fields.get("Size") ?? 0) });
  }
  return entries;
}

/**
 * Reads only the first bytes of one file inside an archive: 7-Zip streams it to
 * stdout and is stopped once enough bytes arrived. Used to look at a disc header
 * (GameCube? Wii? PS2?) without extracting a multi-GB image.
 */
export async function readArchiveEntryHeader(sevenZipPath: string, archivePath: string, entryPath: string, byteCount: number): Promise<Uint8Array> {
  // -so: write to stdout. -spd: treat the entry name literally (no wildcards).
  const streamProcess = Bun.spawn([sevenZipPath, "e", "-so", "-spd", "-p", "--", archivePath, entryPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const collectedChunks: Uint8Array[] = [];
  let collectedBytes = 0;
  try {
    for await (const chunk of streamProcess.stdout) {
      collectedChunks.push(chunk);
      collectedBytes += chunk.byteLength;
      if (collectedBytes >= byteCount) break;
    }
  } finally {
    streamProcess.kill();
  }

  const header = new Uint8Array(Math.min(collectedBytes, byteCount));
  let writeOffset = 0;
  for (const chunk of collectedChunks) {
    const bytesToCopy = Math.min(chunk.byteLength, header.length - writeOffset);
    header.set(chunk.subarray(0, bytesToCopy), writeOffset);
    writeOffset += bytesToCopy;
    if (writeOffset >= header.length) break;
  }
  return header;
}

async function runSevenZip(sevenZipPath: string, commandArguments: string[]): Promise<void> {
  // -bso0 / -bsp0 silence normal output and the percentage indicator; errors still go to stderr.
  const fullArguments = [commandArguments[0]!, "-bso0", "-bsp0", ...commandArguments.slice(1)];
  logger.debug(`7z ${fullArguments.join(" ")}`);

  const sevenZipProcess = Bun.spawn([sevenZipPath, ...fullArguments], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, errorOutput, standardOutput] = await Promise.all([
    sevenZipProcess.exited,
    new Response(sevenZipProcess.stderr).text(),
    new Response(sevenZipProcess.stdout).text(),
  ]);
  const combinedOutput = `${errorOutput}\n${standardOutput}`.trim();

  // 7-Zip exit codes: 0 = OK, 1 = warning (e.g. a locked file), 2+ = fatal.
  if (exitCode === 1) {
    logger.warn(`7-Zip finished with warnings:\n${combinedOutput}`);
    return;
  }
  if (exitCode !== 0) {
    if (/wrong password|encrypted/i.test(combinedOutput)) {
      throw new RomkitError("The archive is password-protected; romkit cannot extract it.");
    }
    if (/can ?not open .* as archive|is not archive/i.test(combinedOutput)) {
      throw new RomkitError("7-Zip could not open the file as an archive (corrupted or incomplete download?).");
    }
    throw new RomkitError(`7-Zip failed (exit code ${exitCode}):\n${combinedOutput}`);
  }
}
