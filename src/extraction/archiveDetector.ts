/**
 * Detects archive type from the first bytes of the file ("magic bytes"),
 * because file extensions on downloaded files are often wrong or missing.
 */

export type ArchiveFormat = "zip" | "rar" | "7z";

const ARCHIVE_SIGNATURES: { format: ArchiveFormat; bytes: number[] }[] = [
  { format: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] }, // "PK\x03\x04": normal zip
  { format: "zip", bytes: [0x50, 0x4b, 0x05, 0x06] }, // "PK\x05\x06": empty zip
  { format: "zip", bytes: [0x50, 0x4b, 0x07, 0x08] }, // "PK\x07\x08": spanned zip
  { format: "rar", bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] }, // "Rar!\x1A\x07": RAR 4 and RAR 5 share this prefix
  { format: "7z", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }, // "7z\xBC\xAF\x27\x1C"
];

const HEADER_LENGTH = 8;

export function detectArchiveFormatFromBytes(header: Uint8Array): ArchiveFormat | null {
  const matchingSignature = ARCHIVE_SIGNATURES.find((signature) =>
    signature.bytes.every((expectedByte, byteIndex) => header[byteIndex] === expectedByte),
  );
  return matchingSignature?.format ?? null;
}

export async function detectArchiveFormat(filePath: string): Promise<ArchiveFormat | null> {
  const header = new Uint8Array(await Bun.file(filePath).slice(0, HEADER_LENGTH).arrayBuffer());
  return detectArchiveFormatFromBytes(header);
}
