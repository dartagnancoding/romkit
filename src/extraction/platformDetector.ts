/**
 * Guesses which console a file belongs to from its first bytes. Used by `inbox`
 * when the extension alone is ambiguous: an .iso can be GameCube, Wii, PS2 or
 * PSP; a .bin can be a Mega Drive cartridge or a raw CD image.
 *
 * Returns catalog system ids (see src/catalog/systemCatalog.ts), most specific
 * first. An empty list means "no idea".
 */

import { detectRomExtensionFromBytes } from "./romSignatures";

/** Enough to reach the ISO 9660 volume descriptor of a raw CD image (sector 16 × 2352 + headers). */
export const PLATFORM_HEADER_LENGTH = 16 * 2352 + 64;

/** Raw CD sectors (2352 bytes, as in .bin files) start with this 12-byte sync pattern. */
const CD_SYNC_PATTERN = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

function bytesMatch(header: Uint8Array, offset: number, expected: number[]): boolean {
  return expected.every((expectedByte, byteIndex) => header[offset + byteIndex] === expectedByte);
}

function asciiAt(header: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...header.subarray(offset, offset + length));
}

export function isRawCdImage(header: Uint8Array): boolean {
  return bytesMatch(header, 0, CD_SYNC_PATTERN);
}

/** "MODE1/2352" or "MODE2/2352", read from the mode byte of sector 16 (the volume descriptor). */
export function rawCdTrackMode(header: Uint8Array): string {
  const modeByte = header[16 * 2352 + 15];
  return modeByte === 1 ? "MODE1/2352" : "MODE2/2352";
}

export function detectPlatformIds(header: Uint8Array): string[] {
  // Cartridge ROMs with a recognizable header.
  const romSignature = detectRomExtensionFromBytes(header);
  if (romSignature?.extension === ".gba") return ["GBA"];
  if (romSignature?.extension === ".nes") return ["NES"];
  if (romSignature && [".z64", ".v64", ".n64"].includes(romSignature.extension)) return ["N64"];
  // Mega Drive / 32X cartridges have "SEGA" at 0x100.
  if (asciiAt(header, 0x100, 8) === "SEGA 32X") return ["32X"];
  if (asciiAt(header, 0x100, 4) === "SEGA") return ["MD"];

  // Nintendo optical discs carry a magic word in the disc header.
  if (bytesMatch(header, 0x1c, [0xc2, 0x33, 0x9f, 0x3d])) return ["GC"];
  if (bytesMatch(header, 0x18, [0x5d, 0x1c, 0x9e, 0xa3])) return ["WII"];

  // Raw CD images (.bin): the data starts 16 bytes into each 2352-byte sector.
  if (isRawCdImage(header)) {
    const sectorZeroText = asciiAt(header, 16, 16);
    if (sectorZeroText.startsWith("SEGADISCSYSTEM")) return ["SEGACD"];
    if (sectorZeroText.startsWith("SEGA SEGASATURN")) return ["SATURN"];
    // ISO 9660 primary volume descriptor in sector 16; "system identifier" 8 bytes in.
    const rawSystemId = asciiAt(header, 16 * 2352 + 24 + 8, 32).trim();
    if (rawSystemId.startsWith("PLAYSTATION")) return ["PS1"];
    return [];
  }

  // Plain ISO 9660 images (.iso): volume descriptor at 0x8000.
  const isoSystemId = asciiAt(header, 0x8008, 32).trim();
  if (isoSystemId.startsWith("PLAYSTATION")) return ["PS2", "PS1"];
  if (isoSystemId.startsWith("PSP GAME")) return ["PSP"];
  return [];
}
