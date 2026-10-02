/**
 * romkit verify -sys <system>
 *
 * Checks every ROM in a system folder against the system's No-Intro/Redump DAT:
 *   verified  the checksum is a known good dump;
 *   unknown   not in the DAT: a hack, a translation, a bad or modified dump, or a
 *             release the DAT does not cover.
 * Results (and the DAT's release name) are saved in the library index.
 */

import { basename } from "node:path";
import { resolveSystemFromFlagOrPrompt } from "../../config/systemResolver";
import { RomkitError } from "../../errors";
import { buildRomUnits } from "../../extraction/romUnits";
import { loadDatIndex } from "../../identification/datIndex";
import { hashFile } from "../../identification/fileHasher";
import { logger } from "../../logging/logger";
import { LibraryIndex } from "../../organization/libraryIndex";
import { isDirectory, listFilesShallow, pathExists } from "../../util/fileSystem";
import type { CommandContext } from "../commandContext";
import { statusLine } from "../progressBar";
import { style } from "../terminalStyle";

export async function runVerifyCommand(context: CommandContext): Promise<void> {
  const { args, config, prompter } = context;
  const system = await resolveSystemFromFlagOrPrompt(config, args.flags.system, prompter);

  if (system.mode === "arcade") {
    throw new RomkitError(`${system.id} is an arcade system; verify romsets with your emulator's own audit tool (e.g. MAME's -verifyroms).`);
  }
  if (!system.datPath || !(await pathExists(system.datPath))) {
    throw new RomkitError(
      `${system.id} has no DAT file${system.datPath ? ` (not found: ${system.datPath})` : ""}; there is nothing to verify against.`,
      `Download the ${system.name} DAT (No-Intro for cartridges, Redump for discs) and set "datPath" for ${system.id} in the config.`,
    );
  }
  if (!(await isDirectory(system.folderPath))) throw new RomkitError(`The folder for ${system.id} does not exist: ${system.folderPath}`);

  const datIndex = await loadDatIndex(system.datPath);
  const libraryIndex = await LibraryIndex.load(system.folderPath);
  const scan = await buildRomUnits(await listFilesShallow(system.folderPath), system.extensions);

  const unknownFiles: string[] = [];
  let verifiedCount = 0;
  for (const [unitIndex, unit] of scan.units.entries()) {
    const fileName = basename(unit.primaryFilePath);
    statusLine.update(`Verifying ${unitIndex + 1}/${scan.units.length}: ${fileName}`);
    // Same rule as identification: for a cue sheet, the first track carries the data.
    const fileToHash = unit.kind === "cue-sheet" ? (unit.cueReferences[0]?.filePath ?? unit.primaryFilePath) : unit.primaryFilePath;
    const hashes = await hashFile(fileToHash);
    const datGame = datIndex.findByHashes(hashes);

    const previousEntry = libraryIndex.get(fileName);
    libraryIndex.set(fileName, {
      // A verified file's true release is the DAT name; otherwise keep what was recorded.
      releaseName: datGame?.name ?? previousEntry?.releaseName ?? fileName,
      addedAt: previousEntry?.addedAt ?? new Date().toISOString(),
      crc32: hashes.crc32,
      sha1: hashes.sha1,
      verified: datGame !== null,
    });
    if (datGame) verifiedCount++;
    else unknownFiles.push(fileName);
  }
  statusLine.clear();
  await libraryIndex.save();

  logger.success(`${verifiedCount} of ${scan.units.length} ${system.id} file(s) are verified good dumps.`);
  if (unknownFiles.length > 0) {
    logger.warn(`${unknownFiles.length} not found in the DAT (hack, translation, bad/modified dump, or not covered by this DAT):`);
    for (const fileName of unknownFiles) logger.info(`  ${style.yellow(fileName)}`);
  }
}
