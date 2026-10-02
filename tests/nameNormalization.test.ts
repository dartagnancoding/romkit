/** Tests for everything that turns a raw ROM name into the final file name. */

import { describe, expect, test } from "bun:test";
import type { NamingSettings } from "../src/config/configTypes";
import { RomkitError } from "../src/errors";
import { sanitizeFileName } from "../src/naming/filenameSanitizer";
import { formatRomBaseName, selectKeptTags } from "../src/naming/nameFormatter";
import { isRegionTag, parseRomName } from "../src/naming/tagParser";
import { compactKey, normalizeTitleForComparison } from "../src/naming/titleNormalization";

const DEFAULT_NAMING: NamingSettings = { template: "{title}", keepTags: [] };

describe("parseRomName", () => {
  test("splits No-Intro names into title and tags", () => {
    const parsed = parseRomName("Mega Man Zero 4 (Europe) (En,Ja,Fr,De,Es,It) (Rev 1)");
    expect(parsed.title).toBe("Mega Man Zero 4");
    expect(parsed.tags.map((tag) => tag.text)).toEqual(["Europe", "En,Ja,Fr,De,Es,It", "Rev 1"]);
  });

  test("handles square-bracket tags (translations, GoodTools flags)", () => {
    const parsed = parseRomName("Mother 3 (Japan) [T-En by Fan Translation]");
    expect(parsed.title).toBe("Mother 3");
    expect(parsed.tags).toEqual([
      { text: "Japan", bracket: "round" },
      { text: "T-En by Fan Translation", bracket: "square" },
    ]);
    expect(parseRomName("Sonic (U) [!]").tags.map((tag) => tag.text)).toEqual(["U", "!"]);
  });

  test("keeps parentheses that are part of the title", () => {
    expect(parseRomName("Title (Part 1) - The Subtitle (USA)").title).toBe("Title (Part 1) - The Subtitle");
  });

  test("names without tags are returned unchanged", () => {
    expect(parseRomName("  Golden Sun  ")).toEqual({ title: "Golden Sun", tags: [] });
  });

  test("detects region tags", () => {
    const [usaEurope, languages, revision] = parseRomName("Game (USA, Europe) (En,Fr) (Rev 2)").tags;
    expect(isRegionTag(usaEurope!)).toBe(true);
    expect(isRegionTag(languages!)).toBe(false);
    expect(isRegionTag(revision!)).toBe(false);
  });
});

describe("normalizeTitleForComparison", () => {
  test("lowercases, strips tags, accents and punctuation", () => {
    expect(normalizeTitleForComparison("Pokémon - Ruby Version (USA, Europe)")).toBe("pokemon ruby version");
  });

  test("moves No-Intro trailing articles to the front", () => {
    expect(normalizeTitleForComparison("Legend of Zelda, The - The Minish Cap (Europe)")).toBe("the legend of zelda the minish cap");
  });

  test("treats & as 'and' and underscores as spaces", () => {
    expect(normalizeTitleForComparison("Mario & Luigi")).toBe("mario and luigi");
    expect(normalizeTitleForComparison("mega_man_zero_4")).toBe("mega man zero 4");
  });

  test("compactKey ignores spaces, so aliases match regardless of spacing", () => {
    expect(compactKey("Game Boy Advance")).toBe(compactKey("gameboy-advance"));
    expect(compactKey("MMZ 4")).toBe("mmz4");
  });
});

describe("sanitizeFileName", () => {
  test("replaces characters Windows does not allow", () => {
    expect(sanitizeFileName("Zelda: The Minish Cap")).toBe("Zelda - The Minish Cap");
    expect(sanitizeFileName('What? "Quoted" <Name> | A/B\\C *')).toBe("What 'Quoted' Name A-B-C");
  });

  test("removes trailing dots and spaces", () => {
    expect(sanitizeFileName("Super Mario Bros...  ")).toBe("Super Mario Bros");
  });

  test("avoids reserved device names", () => {
    expect(sanitizeFileName("CON")).toBe("CON_");
    expect(sanitizeFileName("com1")).toBe("com1_");
  });

  test("collapses whitespace and control characters", () => {
    expect(sanitizeFileName("Game\t\tName\n2")).toBe("Game Name 2");
    expect(sanitizeFileName("Game    Name")).toBe("Game Name");
  });

  test("limits the length", () => {
    expect(sanitizeFileName("A".repeat(300)).length).toBeLessThanOrEqual(180);
  });

  test("rejects names with nothing usable", () => {
    expect(() => sanitizeFileName("???")).toThrow(RomkitError);
  });
});

describe("formatRomBaseName", () => {
  const megaManZero = parseRomName("Mega Man Zero 4 (Europe) (En,Ja) (Rev 1) [T-Por by Tradu]");

  test("default template keeps only the title", () => {
    expect(formatRomBaseName(megaManZero, DEFAULT_NAMING, "GBA")).toBe("Mega Man Zero 4");
  });

  test("keepTags patterns keep matching tags with their original brackets", () => {
    const naming: NamingSettings = { template: "{title} {tags}", keepTags: ["Rev *", "T-Por*"] };
    expect(formatRomBaseName(megaManZero, naming, "GBA")).toBe("Mega Man Zero 4 (Rev 1) [T-Por by Tradu]");
  });

  test("keepTags patterns are case-insensitive and accept brackets", () => {
    expect(selectKeptTags(megaManZero.tags, ["(rev*)"]).map((tag) => tag.text)).toEqual(["Rev 1"]);
  });

  test("{region} and {system} tokens", () => {
    const naming: NamingSettings = { template: "{title} ({region}) - {system}", keepTags: [] };
    expect(formatRomBaseName(megaManZero, naming, "GBA")).toBe("Mega Man Zero 4 (Europe) - GBA");
  });

  test("empty brackets left by missing values are removed", () => {
    const naming: NamingSettings = { template: "{title} ({region})", keepTags: [] };
    expect(formatRomBaseName(parseRomName("Homebrew Game"), naming, "GBA")).toBe("Homebrew Game");
  });

  test("the result is always a valid file name", () => {
    expect(formatRomBaseName(parseRomName("Zelda: Four Swords (USA)"), DEFAULT_NAMING, "GBA")).toBe("Zelda - Four Swords");
  });
});
