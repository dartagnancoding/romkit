/**
 * CRC32 and SHA1 of a file, computed in one streaming pass so large disc images
 * never have to fit in memory.
 */

export interface FileHashes {
  /** 8 lowercase hex digits, as in No-Intro/Redump DATs. */
  crc32: string;
  /** 40 lowercase hex digits. */
  sha1: string;
  size: number;
}

export async function hashFile(filePath: string): Promise<FileHashes> {
  const sha1Hasher = new Bun.CryptoHasher("sha1");
  let crc32 = 0;
  let size = 0;

  for await (const chunk of Bun.file(filePath).stream()) {
    sha1Hasher.update(chunk);
    // Passing the previous value as seed continues the same CRC across chunks.
    crc32 = Bun.hash.crc32(chunk, crc32);
    size += chunk.byteLength;
  }

  return {
    // ">>> 0" makes sure the value is read as unsigned before formatting.
    crc32: (crc32 >>> 0).toString(16).padStart(8, "0"),
    sha1: sha1Hasher.digest("hex"),
    size,
  };
}
