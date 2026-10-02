import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/cli/argumentParser";
import { UsageError } from "../src/errors";

describe("parseArguments", () => {
  test("collects command and title words as positionals", () => {
    const parsed = parseArguments(["download", "mega", "man", "zero", "4"]);
    expect(parsed.positionals).toEqual(["download", "mega", "man", "zero", "4"]);
    expect(parsed.flags.system).toBeUndefined();
  });

  test("accepts every spelling of the system flag", () => {
    for (const spelling of ["-sys", "--sys", "-s", "--system"]) {
      const parsed = parseArguments(["download", "zelda", spelling, "GBA"]);
      expect(parsed.flags.system).toBe("GBA");
      expect(parsed.positionals).toEqual(["download", "zelda"]);
    }
  });

  test("flag spellings are case-insensitive (PowerShell style)", () => {
    expect(parseArguments(["organize", "-Sys", "gba", "--Dry-Run"]).flags).toMatchObject({ system: "gba", dryRun: true });
  });

  test("flags may appear before, between or after positionals", () => {
    const parsed = parseArguments(["-v", "download", "-sys", "gba", "mega", "man"]);
    expect(parsed.positionals).toEqual(["download", "mega", "man"]);
    expect(parsed.flags.verbose).toBe(true);
    expect(parsed.flags.system).toBe("gba");
  });

  test("supports --flag=value", () => {
    expect(parseArguments(["--config=C:\\romkit.json", "systems"]).flags.config).toBe("C:\\romkit.json");
    expect(parseArguments(["-sys=snes", "organize"]).flags.system).toBe("snes");
  });

  test("boolean flags and short aliases", () => {
    const parsed = parseArguments(["organize", "-n", "-y", "-v"]);
    expect(parsed.flags).toMatchObject({ dryRun: true, yes: true, verbose: true, help: false });
    expect([...parsed.providedFlags].sort()).toEqual(["dryRun", "verbose", "yes"]);
  });

  test("system values with spaces are kept whole", () => {
    expect(parseArguments(["download", "zelda", "-sys", "game boy advance"]).flags.system).toBe("game boy advance");
  });

  test("-- ends flag parsing so titles may start with a dash", () => {
    const parsed = parseArguments(["download", "-sys", "gba", "--", "-hyphen-title"]);
    expect(parsed.positionals).toEqual(["download", "-hyphen-title"]);
  });

  test("unknown flags are rejected", () => {
    expect(() => parseArguments(["download", "--fast"])).toThrow(UsageError);
  });

  test("bundled short flags are not supported", () => {
    expect(() => parseArguments(["organize", "-nv"])).toThrow(/Unknown option "-nv"/);
  });

  test("a value flag without a value is rejected", () => {
    expect(() => parseArguments(["download", "zelda", "-sys"])).toThrow(/needs a value/);
    expect(() => parseArguments(["download", "-sys", "--verbose"])).toThrow(/needs a value/);
    expect(() => parseArguments(["download", "--config="])).toThrow(/non-empty/);
  });

  test("a boolean flag with a value is rejected", () => {
    expect(() => parseArguments(["organize", "--dry-run=yes"])).toThrow(/does not take a value/);
  });

  test("a lone dash is a positional", () => {
    expect(parseArguments(["import", "-"]).positionals).toEqual(["import", "-"]);
  });
});
