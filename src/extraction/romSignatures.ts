/**
 * Recognizes ROM files by their first bytes, for old dumps that come without an
 * extension (e.g. "GE00" instead of "GoldenEye.z64").
 *
 * Only used for files whose extension is not accepted; a file is rescued only
 * when the detected extension is one the system accepts.
 */

interface RomSignature {
  extension: string;
  offset: number;
  bytes: number[];
  description: string;
}

const ROM_SIGNATURES: RomSignature[] = [
  // N64 ROMs exist in three byte orders; the first word tells which one.
  { extension: ".z64", offset: 0, bytes: [0x80, 0x37, 0x12, 0x40], description: "N64 (big-endian)" },
  { extension: ".v64", offset: 0, bytes: [0x37, 0x80, 0x40, 0x12], description: "N64 (byte-swapped)" },
  { extension: ".n64", offset: 0, bytes: [0x40, 0x12, 0x37, 0x80], description: "N64 (little-endian)" },
  // iNES header: "NES" followed by the MS-DOS end-of-file byte.
  { extension: ".nes", offset: 0, bytes: [0x4e, 0x45, 0x53, 0x1a], description: "NES (iNES header)" },
  // GBA cartridges carry the Nintendo logo right after the 4-byte entry point.
  { extension: ".gba", offset: 4, bytes: [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21], description: "GBA (Nintendo logo)" },
];

const HEADER_LENGTH = 16;

export function detectRomExtensionFromBytes(header: Uint8Array): RomSignature | null {
  return (
    ROM_SIGNATURES.find((signature) =>
      signature.bytes.every((expectedByte, byteIndex) => header[signature.offset + byteIndex] === expectedByte),
    ) ?? null
  );
}

/** Returns the extension the file should have (e.g. ".z64"), or null when unknown. */
export async function detectRomExtension(filePath: string): Promise<{ extension: string; description: string } | null> {
  const header = new Uint8Array(await Bun.file(filePath).slice(0, HEADER_LENGTH).arrayBuffer());
  return detectRomExtensionFromBytes(header);
}
