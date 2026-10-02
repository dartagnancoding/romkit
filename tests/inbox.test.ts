/** Tests for console detection by header and for grouping inbox files into items. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { detectPlatformIds, isRawCdImage, rawCdTrackMode } from "../src/extraction/platformDetector";
import { scanInbox } from "../src/inbox/inboxScanner";

/** Builds a fake header: zero bytes with the given ASCII/bytes written at offsets. */
function headerWith(length: number, writes: { offset: number; bytes: number[] | string }[]): Uint8Array {
  const header = new Uint8Array(length);
  for (const write of writes) {
    const bytes = typeof write.bytes === "string" ? [...write.bytes].map((character) => character.charCodeAt(0)) : write.bytes;
    header.set(bytes, write.offset);
  }
  return header;
}

const CD_SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

describe("detectPlatformIds", () => {
  test("GameCube and Wii disc magic words", () => {
    expect(detectPlatformIds(headerWith(0x40, [{ offset: 0x1c, bytes: [0xc2, 0x33, 0x9f, 0x3d] }]))).toEqual(["GC"]);
    expect(detectPlatformIds(headerWith(0x40, [{ offset: 0x18, bytes: [0x5d, 0x1c, 0x9e, 0xa3] }]))).toEqual(["WII"]);
  });

  test("PlayStation ISO volume descriptor prefers PS2, PSP is separate", () => {
    expect(detectPlatformIds(headerWith(0x8100, [{ offset: 0x8008, bytes: "PLAYSTATION" }]))).toEqual(["PS2", "PS1"]);
    expect(detectPlatformIds(headerWith(0x8100, [{ offset: 0x8008, bytes: "PSP GAME" }]))).toEqual(["PSP"]);
  });

  test("raw CD images: PS1, Sega CD, Saturn", () => {
    const sector16 = 16 * 2352;
    const ps1 = headerWith(sector16 + 64, [
      { offset: 0, bytes: CD_SYNC },
      { offset: sector16 + 15, bytes: [2] },
      { offset: sector16 + 24 + 8, bytes: "PLAYSTATION" },
    ]);
    expect(isRawCdImage(ps1)).toBe(true);
    expect(rawCdTrackMode(ps1)).toBe("MODE2/2352");
    expect(detectPlatformIds(ps1)).toEqual(["PS1"]);
    expect(detectPlatformIds(headerWith(64, [{ offset: 0, bytes: CD_SYNC }, { offset: 16, bytes: "SEGADISCSYSTEM" }]))).toEqual(["SEGACD"]);
    expect(detectPlatformIds(headerWith(64, [{ offset: 0, bytes: CD_SYNC }, { offset: 16, bytes: "SEGA SEGASATURN" }]))).toEqual(["SATURN"]);
  });

  test("Mega Drive cartridge and unknown data", () => {
    expect(detectPlatformIds(headerWith(0x200, [{ offset: 0x100, bytes: "SEGA MEGA DRIVE" }]))).toEqual(["MD"]);
    expect(detectPlatformIds(new Uint8Array(0x9000))).toEqual([]);
  });
});

describe("scanInbox", () => {
  const inbox = mkdtempSync(join(tmpdir(), "romkit-inbox-"));
  afterAll(() => rmSync(inbox, { recursive: true, force: true }));

  const createFile = (relativePath: string, content = "x") => {
    const filePath = join(inbox, relativePath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
    return filePath;
  };

  test("groups cue tracks and RAR volumes, separates non-game files", async () => {
    createFile("ps1/Game.cue", 'FILE "Game (Track 1).bin" BINARY\nFILE "Game (Track 2).bin" BINARY');
    createFile("ps1/Game (Track 1).bin");
    createFile("ps1/Game (Track 2).bin");
    createFile("Big.part01.rar");
    createFile("Big.part02.rar");
    createFile("Big.part03.rar");
    createFile("Old.rar");
    createFile("Old.r00");
    createFile("Old.r01");
    createFile("game.gba");
    createFile("readme.txt");
    createFile("Organizar dump.bat");

    const scan = await scanInbox(inbox);
    const itemNames = scan.items.map((item) => basename(item.filePath)).sort();
    expect(itemNames).toEqual(["Big.part01.rar", "Game.cue", "Old.rar", "game.gba"]);
    const bigItem = scan.items.find((item) => basename(item.filePath) === "Big.part01.rar")!;
    expect(bigItem.companionPaths.map((companionPath) => basename(companionPath)).sort()).toEqual(["Big.part02.rar", "Big.part03.rar"]);
    expect(scan.looseFiles.map((filePath) => basename(filePath))).toEqual(["readme.txt"]);
  });
});
