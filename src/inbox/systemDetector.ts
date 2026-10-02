/**
 * Decides which configured system(s) a file in the inbox belongs to, without -sys.
 *
 * Evidence, strongest first:
 *   1. a folder name on the way from the inbox to the file ("inbox\snes\game.zip");
 *   2. for archives: the files inside (listed, not extracted) and, when the
 *      extension is ambiguous, the header of the main file (streamed from the archive);
 *   3. for loose files: the extension, narrowed by the header when ambiguous
 *      (.iso → GameCube/Wii/PS2, .bin → Mega Drive cartridge or PS1 CD).
 *
 * Returns every plausible system; the caller asks the user when there is more than one.
 */

import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type { ResolvedConfig, ResolvedSystem } from "../config/configTypes";
import { findSystem } from "../config/systemResolver";
import { detectArchiveFormat } from "../extraction/archiveDetector";
import { parseCueFileReferences, readCueSheet } from "../extraction/cueSheet";
import { detectPlatformIds, isRawCdImage, PLATFORM_HEADER_LENGTH } from "../extraction/platformDetector";
import { listArchiveEntries, readArchiveEntryHeader } from "../extraction/sevenZip";
import { pathExists } from "../util/fileSystem";

export interface SystemDetection {
  systems: ResolvedSystem[];
  /** Short explanation shown to the user, e.g. 'folder "snes"' or "GameCube disc header". */
  reason: string;
}

/** How many of the largest files inside an archive are inspected. */
const MAX_ARCHIVE_ENTRIES_TO_INSPECT = 3;

export async function detectSystemsForFile(filePath: string, inboxRoot: string, config: ResolvedConfig): Promise<SystemDetection> {
  const folderDetection = detectFromFolderNames(filePath, inboxRoot, config);
  if (folderDetection?.systems.length === 1) return folderDetection;
  // A folder like "WII, Gamecube" names several systems: content decides between them.
  const allowedSystems = folderDetection?.systems ?? config.systems;

  const contentDetection = (await detectArchiveFormat(filePath))
    ? await detectFromArchive(filePath, allowedSystems, config)
    : await detectFromLooseFile(filePath, allowedSystems);

  if (contentDetection.systems.length === 0 && folderDetection) return folderDetection;
  return contentDetection;
}

/** Looks at each folder between the inbox and the file, nearest first. */
function detectFromFolderNames(filePath: string, inboxRoot: string, config: ResolvedConfig): SystemDetection | null {
  const relativeFolder = relative(resolve(inboxRoot), resolve(dirname(filePath)));
  if (relativeFolder === "" || relativeFolder.startsWith("..")) return null;

  const folderNames = relativeFolder.split(sep).reverse();
  for (const folderName of folderNames) {
    // "WII, Gamecube" → ["WII", "Gamecube"]
    const nameParts = folderName.split(/[,&+]/).map((part) => part.trim()).filter(Boolean);
    const matchedSystems = uniqueSystems(nameParts.map((part) => findSystem(config, part)).filter((system): system is ResolvedSystem => system !== null));
    if (matchedSystems.length > 0) return { systems: matchedSystems, reason: `folder "${folderName}"` };
  }
  return null;
}

async function detectFromLooseFile(filePath: string, allowedSystems: ResolvedSystem[]): Promise<SystemDetection> {
  const extension = extname(filePath).toLowerCase();

  // A .cue belongs to disc systems; its first track's header tells which one.
  if (extension === ".cue") {
    const discSystems = allowedSystems.filter((system) => system.extensions.includes(".cue"));
    const firstTrack = parseCueFileReferences(await readCueSheet(filePath))[0];
    const trackPath = firstTrack ? resolve(dirname(filePath), firstTrack) : null;
    if (trackPath && discSystems.length > 1 && (await pathExists(trackPath))) {
      const platformIds = detectPlatformIds(await readFileHeader(trackPath));
      return narrowByPlatform(discSystems, platformIds, "cue sheet");
    }
    return { systems: discSystems, reason: "cue sheet" };
  }

  const header = await readFileHeader(filePath);
  return candidatesForFile(extension, header, allowedSystems);
}

async function detectFromArchive(archivePath: string, allowedSystems: ResolvedSystem[], config: ResolvedConfig): Promise<SystemDetection> {
  const archiveFormat = await detectArchiveFormat(archivePath);
  const nonArcadeSystems = allowedSystems.filter((system) => system.mode !== "arcade");
  const arcadeSystems = allowedSystems.filter((system) => system.mode === "arcade");

  let entries;
  try {
    entries = await listArchiveEntries(config.sevenZipPath, archivePath);
  } catch {
    return { systems: [], reason: "could not list the archive (corrupted, incomplete or password-protected?)" };
  }

  // Inspect the biggest files first: the game is almost always the largest file.
  const interestingEntries = entries
    .filter((entry) => !/\.(txt|nfo|url|htm|html|sfv|jpg|png|pdf|diz)$/i.test(entry.path))
    .sort((first, second) => second.size - first.size)
    .slice(0, MAX_ARCHIVE_ENTRIES_TO_INSPECT);

  let collectedSystems: ResolvedSystem[] = [];
  const reasons: string[] = [];
  for (const entry of interestingEntries) {
    const extension = extname(entry.path).toLowerCase();
    const byExtension = systemsAcceptingExtension(extension, nonArcadeSystems);
    // Only stream the header when the extension does not settle it (or is missing).
    const needsHeader = byExtension.length !== 1;
    const header = needsHeader ? await readArchiveEntryHeader(config.sevenZipPath, archivePath, entry.path, PLATFORM_HEADER_LENGTH) : null;
    const detection = header ? candidatesForFile(extension, header, nonArcadeSystems) : { systems: byExtension, reason: `${extension} file` };
    if (detection.systems.length > 0) {
      collectedSystems = uniqueSystems([...collectedSystems, ...detection.systems]);
      reasons.push(`${basename(entry.path)}: ${detection.reason}`);
      // The largest recognized file decides; smaller ones are usually extras.
      break;
    }
  }

  if (collectedSystems.length > 0) return { systems: collectedSystems, reason: `inside the archive, ${reasons.join("; ")}` };

  // Nothing inside looks like a console ROM: a zip/7z is then most likely an arcade romset.
  if (arcadeSystems.length > 0 && (archiveFormat === "zip" || archiveFormat === "7z")) {
    return { systems: arcadeSystems, reason: "archive without console ROMs (arcade romset)" };
  }
  return { systems: [], reason: "no recognizable ROM inside the archive" };
}

/** Candidates from the extension, narrowed (or found) by the file header. */
function candidatesForFile(extension: string, header: Uint8Array, allowedSystems: ResolvedSystem[]): SystemDetection {
  const platformIds = detectPlatformIds(header);
  let byExtension = systemsAcceptingExtension(extension, allowedSystems);

  // A raw CD .bin also fits systems that take cue sheets (a cue is generated for it).
  if (extension === ".bin" && isRawCdImage(header)) {
    byExtension = uniqueSystems([
      ...byExtension.filter((system) => system.extensions.includes(".cue")),
      ...allowedSystems.filter((system) => system.extensions.includes(".cue")),
    ]);
  }

  // No usable extension (e.g. "GE00"): rely on the header alone.
  if (byExtension.length === 0 && platformIds.length > 0) {
    const byPlatform = allowedSystems.filter((system) => platformIds.includes(system.id.toUpperCase()));
    return { systems: byPlatform, reason: `${platformIds[0]} header` };
  }
  return narrowByPlatform(byExtension, platformIds, extension ? `${extension} file` : "file");
}

function narrowByPlatform(candidates: ResolvedSystem[], platformIds: string[], baseReason: string): SystemDetection {
  if (candidates.length <= 1 || platformIds.length === 0) return { systems: candidates, reason: baseReason };
  // platformIds is ordered most-likely first ("PLAYSTATION" ISO → PS2 before PS1).
  for (const platformId of platformIds) {
    const matching = candidates.filter((system) => system.id.toUpperCase() === platformId);
    if (matching.length > 0) return { systems: matching, reason: `${baseReason}, ${platformId} header` };
  }
  return { systems: candidates, reason: baseReason };
}

function systemsAcceptingExtension(extension: string, systems: ResolvedSystem[]): ResolvedSystem[] {
  if (extension === "") return [];
  return systems.filter((system) => system.extensions.includes(extension));
}

function uniqueSystems(systems: ResolvedSystem[]): ResolvedSystem[] {
  return [...new Map(systems.map((system) => [system.id, system])).values()];
}

async function readFileHeader(filePath: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(filePath).slice(0, PLATFORM_HEADER_LENGTH).arrayBuffer());
}
