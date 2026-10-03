import { describe, expect, test } from "bun:test";
import type { ReleasePreferences } from "../src/config/configTypes";
import { compareReleases, describeTraits } from "../src/naming/releasePreference";
import { parseRomName } from "../src/naming/tagParser";

const AVOID_TRANSLATIONS: ReleasePreferences = { regionOrder: ["USA", "World", "Europe", "Japan"], translations: "avoid" };
const tagsOf = (name: string) => parseRomName(name).tags;
/** > 0 when the first name is the better release. */
const compare = (first: string, second: string, preferences = AVOID_TRANSLATIONS) => compareReleases(tagsOf(first), tagsOf(second), preferences);

describe("compareReleases", () => {
  test("region order: USA > World > Europe > Japan", () => {
    expect(compare("Game (USA)", "Game (Europe)")).toBeGreaterThan(0);
    expect(compare("Game (Japan)", "Game (World)")).toBeLessThan(0);
    expect(compare("Game (USA, Europe)", "Game (World)")).toBeGreaterThan(0);
  });

  test("GoodTools region codes are understood", () => {
    expect(compare("Game (U) [!]", "Game (E) [!]")).toBeGreaterThan(0);
    expect(compare("Game (J)", "Game (E)")).toBeLessThan(0);
  });

  test("translations lose when avoided, even against a worse region", () => {
    expect(compare("Mega Man Zero 4 (BR)", "Mega Man Zero 4 (Europe)")).toBeLessThan(0);
    expect(compare("Chrono Trigger (USA) [T-Por by X]", "Chrono Trigger (Japan)")).toBeLessThan(0);
    expect(compare("Game [Pt-br]", "Game (USA)")).toBeLessThan(0);
  });

  test("translations win when preferred, and are ignored when neutral", () => {
    const preferTranslations: ReleasePreferences = { ...AVOID_TRANSLATIONS, translations: "prefer" };
    expect(compare("Game (USA) [T-Por]", "Game (USA)", preferTranslations)).toBeGreaterThan(0);
    const neutral: ReleasePreferences = { ...AVOID_TRANSLATIONS, translations: "neutral" };
    expect(compare("Game (USA) [T-Por]", "Game (Europe)", neutral)).toBeGreaterThan(0);
  });

  test("Brazil is an official region, not a translation", () => {
    expect(describeTraits(tagsOf("Game (Brazil)"), AVOID_TRANSLATIONS).isTranslation).toBe(false);
    expect(describeTraits(tagsOf("Game (BR)"), AVOID_TRANSLATIONS).isTranslation).toBe(true);
  });

  test("bad dumps and hacks lose against clean dumps", () => {
    expect(compare("Game (USA) [b1]", "Game (Japan)")).toBeLessThan(0);
    expect(compare("Game (USA) [h2]", "Game (Europe)")).toBeLessThan(0);
  });

  test("prototypes, betas and demos lose against final releases", () => {
    expect(compare("Mega Man 3 (Prototype) (U) [!]", "Mega Man 3 (U) [!]")).toBeLessThan(0);
    expect(compare("Game (USA) (Beta)", "Game (Japan)")).toBeLessThan(0);
    expect(compare("Game (Europe) (Demo)", "Game (Europe) (Proto 2)")).toBe(0);
  });

  test("verified [!] and higher revisions win when all else is equal", () => {
    expect(compare("Game (USA) [!]", "Game (USA)")).toBeGreaterThan(0);
    expect(compare("Game (USA) (Rev 2)", "Game (USA) (Rev 1)")).toBeGreaterThan(0);
    expect(compare("Game (USA) (Rev 1)", "Game (USA)")).toBeGreaterThan(0);
    expect(compare("Game (USA)", "Game (USA)")).toBe(0);
  });
});
