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
