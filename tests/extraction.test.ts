/** Tests for archive detection, cue sheet handling and ROM unit grouping. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectArchiveFormatFromBytes } from "../src/extraction/archiveDetector";
import { parseCueFileReferences, rewriteCueFileReferences } from "../src/extraction/cueSheet";
import { buildRomUnits } from "../src/extraction/romUnits";
import { planTargetNames } from "../src/organization/libraryOrganizer";

describe("detectArchiveFormatFromBytes", () => {
  test("recognizes zip, rar and 7z signatures", () => {
    expect(detectArchiveFormatFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("zip");
    expect(detectArchiveFormatFromBytes(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))).toBe("rar");
    expect(detectArchiveFormatFromBytes(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe("7z");
  });

  test("anything else is not an archive", () => {
    expect(detectArchiveFormatFromBytes(new Uint8Array([0x2e, 0x00, 0x00, 0xea]))).toBeNull();
    expect(detectArchiveFormatFromBytes(new Uint8Array([]))).toBeNull();
  });
});

const CUE_TEXT = [
  'FILE "Game (USA) (Track 1).bin" BINARY',
  "  TRACK 01 MODE2/2352",
  "    INDEX 01 00:00:00",
  "FILE track2.bin BINARY",
  "  TRACK 02 AUDIO",
  "    INDEX 01 00:00:00",
].join("\r\n");

describe("cue sheets", () => {
  test("lists quoted and unquoted FILE references", () => {
    expect(parseCueFileReferences(CUE_TEXT)).toEqual(["Game (USA) (Track 1).bin", "track2.bin"]);
  });

  test("rewrites references and keeps Windows line endings", () => {
    const rewritten = rewriteCueFileReferences(
      CUE_TEXT,
      new Map([
        ["Game (USA) (Track 1).bin", "Game (Track 1).bin"],
        ["track2.bin", "Game (Track 2).bin"],
      ]),
    );
    expect(parseCueFileReferences(rewritten)).toEqual(["Game (Track 1).bin", "Game (Track 2).bin"]);
    expect(rewritten.split("\r\n")).toHaveLength(6);
    expect(rewritten).toContain("  TRACK 02 AUDIO");
  });
});

describe("buildRomUnits", () => {
  const workDirectory = mkdtempSync(join(tmpdir(), "romkit-test-"));
  afterAll(() => rmSync(workDirectory, { recursive: true, force: true }));

  const createFile = (name: string, content = "x") => {
    const filePath = join(workDirectory, name);
    writeFileSync(filePath, content);
    return filePath;
  };

  test("groups a cue with its tracks and discards other files", async () => {
    const cuePath = createFile("Game (USA).cue", CUE_TEXT);
    const trackOne = createFile("Game (USA) (Track 1).bin");
    const trackTwo = createFile("TRACK2.BIN"); // different case than in the cue: still found
    const readme = createFile("readme.txt");

    const scan = await buildRomUnits([cuePath, trackOne, trackTwo, readme], [".cue", ".chd"]);
    expect(scan.units).toHaveLength(1);
    expect(scan.units[0]).toMatchObject({ kind: "cue-sheet", primaryFilePath: cuePath });
    expect(scan.discardedFilePaths).toEqual([readme]);
    expect(scan.warnings).toEqual([]);
  });

  test("a cue pointing to a missing track is reported and skipped", async () => {
    const brokenCue = createFile("Broken.cue", 'FILE "missing.bin" BINARY');
    const scan = await buildRomUnits([brokenCue], [".cue"]);
    expect(scan.units).toHaveLength(0);
    expect(scan.warnings[0]).toContain("missing.bin");
  });

  test("single-file ROMs, extension check is case-insensitive", async () => {
    const romPath = createFile("Mega Man Zero 4.GBA");
    const nfoPath = createFile("release.nfo");
    const scan = await buildRomUnits([romPath, nfoPath], [".gba"]);
    expect(scan.units).toEqual([{ kind: "single", primaryFilePath: romPath }]);
    expect(scan.discardedFilePaths).toEqual([nfoPath]);
  });
});

describe("planTargetNames", () => {
  test("one track keeps a plain name, several tracks are numbered", () => {
    const singleTrack = planTargetNames(
      { kind: "cue-sheet", primaryFilePath: "C:\\x\\a.cue", cueReferences: [{ reference: "a.bin", filePath: "C:\\x\\a.bin" }] },
      "Game",
    );
    expect(singleTrack.map((plannedFile) => plannedFile.targetName)).toEqual(["Game.cue", "Game.bin"]);

    const cueReferences = Array.from({ length: 11 }, (_, trackIndex) => ({
      reference: `t${trackIndex}.bin`,
      filePath: `C:\\x\\t${trackIndex}.bin`,
    }));
    const manyTracks = planTargetNames({ kind: "cue-sheet", primaryFilePath: "C:\\x\\a.cue", cueReferences }, "Game");
    expect(manyTracks[1]!.targetName).toBe("Game (Track 01).bin");
    expect(manyTracks[11]!.targetName).toBe("Game (Track 11).bin");
  });
});
