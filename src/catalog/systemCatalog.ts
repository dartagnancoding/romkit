/**
 * Built-in list of well-known systems, used by `romkit systems add` to suggest
 * the id, aliases, accepted extensions and the matching No-Intro/Redump DAT.
 *
 * Names are full console names (they become the folder names): "Mega Drive",
 * "GameCube", not abbreviations.
 *
 * Extensions list the files that are the game itself. Track files referenced by
 * a .cue (the .bin files) do not need to be listed: they are picked up through
 * the cue sheet.
 *
 * Feel free to extend this list; every entry can still be edited during `systems add`.
 */

import type { SystemMode } from "../config/configTypes";
import { titleSimilarity } from "../identification/fuzzyMatcher";
import { compactKey, normalizeTitleForComparison } from "../naming/titleNormalization";

export interface CatalogSystem {
  id: string;
  name: string;
  aliases: string[];
  extensions: string[];
  /** DAT name to look for when downloading from the DAT provider. */
  datName: string;
  datProvider: "No-Intro" | "Redump" | "MAME";
  /** "arcade": the archive itself is the game (see SystemMode). */
  mode?: SystemMode;
}

export const SYSTEM_CATALOG: CatalogSystem[] = [
  // Nintendo
  { id: "NES", name: "Nintendo Entertainment System", aliases: ["nes", "famicom", "nintendinho"], extensions: [".nes", ".unf"], datName: "Nintendo - Nintendo Entertainment System (Headered)", datProvider: "No-Intro" },
  { id: "FDS", name: "Famicom Disk System", aliases: ["fds", "famicom disk system"], extensions: [".fds"], datName: "Nintendo - Family Computer Disk System (FDS)", datProvider: "No-Intro" },
  { id: "SNES", name: "Super Nintendo", aliases: ["snes", "super nintendo", "super famicom", "sfc"], extensions: [".sfc", ".smc"], datName: "Nintendo - Super Nintendo Entertainment System", datProvider: "No-Intro" },
  { id: "N64", name: "Nintendo 64", aliases: ["n64", "nintendo 64"], extensions: [".z64", ".n64", ".v64"], datName: "Nintendo - Nintendo 64 (BigEndian)", datProvider: "No-Intro" },
  { id: "GB", name: "Game Boy", aliases: ["gb", "game boy", "gameboy"], extensions: [".gb"], datName: "Nintendo - Game Boy", datProvider: "No-Intro" },
  { id: "GBC", name: "Game Boy Color", aliases: ["gbc", "game boy color", "gameboy color"], extensions: [".gbc"], datName: "Nintendo - Game Boy Color", datProvider: "No-Intro" },
  { id: "GBA", name: "Game Boy Advance", aliases: ["gba", "game boy advance", "gameboy advance"], extensions: [".gba"], datName: "Nintendo - Game Boy Advance", datProvider: "No-Intro" },
  { id: "NDS", name: "Nintendo DS", aliases: ["nds", "ds", "nintendo ds"], extensions: [".nds"], datName: "Nintendo - Nintendo DS (Decrypted)", datProvider: "No-Intro" },
  { id: "3DS", name: "Nintendo 3DS", aliases: ["3ds", "nintendo 3ds"], extensions: [".3ds", ".cia"], datName: "Nintendo - Nintendo 3DS (Decrypted)", datProvider: "No-Intro" },
  { id: "VB", name: "Virtual Boy", aliases: ["vb", "virtual boy"], extensions: [".vb"], datName: "Nintendo - Virtual Boy", datProvider: "No-Intro" },
  { id: "POKEMINI", name: "Pokemon Mini", aliases: ["pokemon mini", "pokemini"], extensions: [".min"], datName: "Nintendo - Pokemon Mini", datProvider: "No-Intro" },
  { id: "GC", name: "GameCube", aliases: ["gc", "gamecube", "ngc"], extensions: [".iso", ".rvz", ".gcm", ".ciso"], datName: "Nintendo - GameCube", datProvider: "Redump" },
  { id: "WII", name: "Wii", aliases: ["wii", "nintendo wii"], extensions: [".iso", ".wbfs", ".rvz"], datName: "Nintendo - Wii", datProvider: "Redump" },

  // Sega
  { id: "SG1000", name: "SG-1000", aliases: ["sg1000", "sg 1000"], extensions: [".sg"], datName: "Sega - SG-1000", datProvider: "No-Intro" },
  { id: "SMS", name: "Master System", aliases: ["sms", "master system", "mark iii"], extensions: [".sms"], datName: "Sega - Master System - Mark III", datProvider: "No-Intro" },
  { id: "GG", name: "Game Gear", aliases: ["gg", "game gear", "gamegear"], extensions: [".gg"], datName: "Sega - Game Gear", datProvider: "No-Intro" },
  { id: "MD", name: "Mega Drive", aliases: ["md", "mega drive", "megadrive", "genesis"], extensions: [".md", ".gen", ".bin", ".smd"], datName: "Sega - Mega Drive - Genesis", datProvider: "No-Intro" },
  { id: "32X", name: "Sega 32X", aliases: ["32x", "sega 32x"], extensions: [".32x"], datName: "Sega - 32X", datProvider: "No-Intro" },
  { id: "SEGACD", name: "Sega CD", aliases: ["sega cd", "mega cd", "megacd"], extensions: [".cue", ".chd"], datName: "Sega - Mega CD & Sega CD", datProvider: "Redump" },
  { id: "SATURN", name: "Sega Saturn", aliases: ["saturn", "sega saturn"], extensions: [".cue", ".chd"], datName: "Sega - Saturn", datProvider: "Redump" },
  { id: "DC", name: "Dreamcast", aliases: ["dc", "dreamcast"], extensions: [".chd", ".cdi"], datName: "Sega - Dreamcast", datProvider: "Redump" },

  // Sony
  { id: "PS1", name: "PlayStation", aliases: ["ps1", "psx", "playstation", "playstation 1", "play 1"], extensions: [".cue", ".chd", ".pbp"], datName: "Sony - PlayStation", datProvider: "Redump" },
  { id: "PS2", name: "PlayStation 2", aliases: ["ps2", "playstation 2", "play 2"], extensions: [".iso", ".chd"], datName: "Sony - PlayStation 2", datProvider: "Redump" },
  { id: "PSP", name: "PlayStation Portable", aliases: ["psp", "playstation portable"], extensions: [".iso", ".cso", ".chd"], datName: "Sony - PlayStation Portable", datProvider: "Redump" },

  // NEC / SNK / Bandai
  { id: "PCE", name: "PC Engine", aliases: ["pce", "pc engine", "turbografx", "tg16"], extensions: [".pce"], datName: "NEC - PC Engine - TurboGrafx-16", datProvider: "No-Intro" },
  { id: "PCECD", name: "PC Engine CD", aliases: ["pce cd", "pc engine cd", "turbografx cd"], extensions: [".cue", ".chd"], datName: "NEC - PC Engine CD & TurboGrafx CD", datProvider: "Redump" },
  { id: "NGP", name: "Neo Geo Pocket", aliases: ["ngp", "neo geo pocket"], extensions: [".ngp"], datName: "SNK - NeoGeo Pocket", datProvider: "No-Intro" },
  { id: "NGPC", name: "Neo Geo Pocket Color", aliases: ["ngpc", "neo geo pocket color"], extensions: [".ngc"], datName: "SNK - NeoGeo Pocket Color", datProvider: "No-Intro" },
  { id: "NEOCD", name: "Neo Geo CD", aliases: ["neo geo cd", "neocd"], extensions: [".cue", ".chd"], datName: "SNK - Neo Geo CD", datProvider: "Redump" },
  { id: "WS", name: "WonderSwan", aliases: ["ws", "wonderswan"], extensions: [".ws"], datName: "Bandai - WonderSwan", datProvider: "No-Intro" },
  { id: "WSC", name: "WonderSwan Color", aliases: ["wsc", "wonderswan color"], extensions: [".wsc"], datName: "Bandai - WonderSwan Color", datProvider: "No-Intro" },

  // Arcade: each .zip/.7z is a romset whose short name (sf2.zip) MAME needs unchanged.
  { id: "MAME", name: "MAME", aliases: ["mame", "arcade", "fbneo", "final burn neo"], extensions: [".zip", ".7z"], datName: "MAME (match your MAME version)", datProvider: "MAME", mode: "arcade" },

  // Atari and others
  { id: "A2600", name: "Atari 2600", aliases: ["atari 2600", "2600", "vcs"], extensions: [".a26", ".bin"], datName: "Atari - 2600", datProvider: "No-Intro" },
  { id: "A7800", name: "Atari 7800", aliases: ["atari 7800", "7800"], extensions: [".a78"], datName: "Atari - 7800", datProvider: "No-Intro" },
  { id: "LYNX", name: "Atari Lynx", aliases: ["lynx", "atari lynx"], extensions: [".lnx"], datName: "Atari - Lynx", datProvider: "No-Intro" },
  { id: "JAGUAR", name: "Atari Jaguar", aliases: ["jaguar", "atari jaguar"], extensions: [".j64", ".jag"], datName: "Atari - Jaguar (J64)", datProvider: "No-Intro" },
  { id: "COLECO", name: "ColecoVision", aliases: ["coleco", "colecovision"], extensions: [".col"], datName: "Coleco - ColecoVision", datProvider: "No-Intro" },
  { id: "INTV", name: "Intellivision", aliases: ["intv", "intellivision"], extensions: [".int"], datName: "Mattel - Intellivision", datProvider: "No-Intro" },
  { id: "MSX", name: "MSX", aliases: ["msx", "msx1"], extensions: [".rom", ".mx1"], datName: "Microsoft - MSX", datProvider: "No-Intro" },
  { id: "MSX2", name: "MSX2", aliases: ["msx2"], extensions: [".rom", ".mx2"], datName: "Microsoft - MSX2", datProvider: "No-Intro" },
  { id: "3DO", name: "3DO", aliases: ["3do", "panasonic 3do"], extensions: [".cue", ".chd", ".iso"], datName: "Panasonic - 3DO Interactive Multiplayer", datProvider: "Redump" },
  { id: "XBOX", name: "Xbox", aliases: ["xbox", "original xbox"], extensions: [".iso"], datName: "Microsoft - Xbox", datProvider: "Redump" },
];

/** Catalog entries best matching what the user typed ("gba", "playstation 2", "mega drive"...). */
export function searchCatalog(query: string, limit = 8): CatalogSystem[] {
  const queryKey = compactKey(query);
  const normalizedQuery = normalizeTitleForComparison(query);
  if (queryKey === "") return [];

  return SYSTEM_CATALOG.map((catalogSystem) => {
    const names = [catalogSystem.id, catalogSystem.name, ...catalogSystem.aliases];
    let bestScore = 0;
    for (const name of names) {
      if (compactKey(name) === queryKey) {
        bestScore = Math.max(bestScore, 1);
        continue;
      }
      let score = titleSimilarity(normalizedQuery, normalizeTitleForComparison(name));
      // "playstation" should list "PlayStation 2" and "PlayStation Portable" too.
      if (compactKey(name).includes(queryKey)) score = Math.max(score, 0.7);
      bestScore = Math.max(bestScore, score);
    }
    return { catalogSystem, score: bestScore };
  })
    .filter((candidate) => candidate.score >= 0.4)
    .sort((first, second) => second.score - first.score)
    .slice(0, limit)
    .map((candidate) => candidate.catalogSystem);
}
