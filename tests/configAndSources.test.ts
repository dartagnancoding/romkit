import { describe, expect, test } from "bun:test";
import { findSetting, parseValue, setValue } from "../src/cli/commands/configCommand";
import { applyImport, buildExport, parseSourcesFile, planImport } from "../src/cli/commands/sourcesCommand";
import type { ConfigFile, SourceConfig, SystemConfig } from "../src/config/configTypes";
import { validateConfigFile } from "../src/config/configValidation";
import { UsageError } from "../src/errors";

const SELECTORS = { resultItem: "tr", title: "a", pageLink: "a", downloadLink: ":self" };
const source = (name: string, systems: string[]): SourceConfig => ({ name, searchUrl: `https://example.invalid/${name}/`, systems, selectors: SELECTORS });
const PS3: SystemConfig = { id: "PS3", name: "PlayStation 3", aliases: ["ps3"], folder: "PlayStation 3", extensions: [".iso"], datPath: "C:\\dats\\ps3.dat", sources: [] };

function baseConfig(): ConfigFile {
  return {
    libraryRoot: "E:\\ROM",
    sevenZipPath: "C:\\Program Files\\7-Zip\\7z.exe",
    sources: [source("NES Pack", ["NES"])],
    systems: [{ id: "NES", name: "NES", folder: "NES", extensions: [".nes"] }],
  };
}

describe("sources import", () => {
  test("adds new sources with the systems they need, keeps existing names, skips unknown systems", () => {
    const config = baseConfig();
    const incoming = buildExport(
      [source("NES Pack", ["NES"]), source("PS3 Part 1", ["PS3"]), source("GBA Pack", ["GBA"]), source("Mystery", ["ZX81"])],
      [PS3],
    );
    const plan = planImport(config, incoming);

    expect(plan.addedSources.map((added) => added.name)).toEqual(["PS3 Part 1", "GBA Pack"]);
    // PS3 comes from the file, GBA from the built-in catalog.
    expect(plan.addedSystems.map((system) => system.id)).toEqual(["PS3", "GBA"]);
    expect(plan.keptExisting).toEqual(["NES Pack"]);
    expect(plan.skippedSources.map((skipped) => skipped.name)).toEqual(["Mystery"]);

    applyImport(config, plan);
    expect(validateConfigFile(config)).toEqual([]);
  });

  test("a system needed by several sources is added once", () => {
    const plan = planImport(baseConfig(), buildExport([source("PS3 Part 1", ["PS3"]), source("PS3 Part 2", ["PS3"])], [PS3]));
    expect(plan.addedSystems.map((system) => system.id)).toEqual(["PS3"]);
  });

  test("exports leave out machine-specific paths", () => {
    const exported = buildExport([], [PS3]);
    expect(exported.systems[0]).not.toHaveProperty("datPath");
    expect(exported.systems[0]).not.toHaveProperty("sources");
  });

  test("a bare list of sources is accepted", () => {
    const parsed = parseSourcesFile(JSON.stringify([source("A", ["NES"])]), "list.json");
    expect(parsed.sources.map((parsedSource) => parsedSource.name)).toEqual(["A"]);
    expect(() => parseSourcesFile("{}", "x.json")).toThrow();
  });
});

describe("config command", () => {
  test("settings are found by full key or by their last part, in any case", () => {
    expect(findSetting("libraryroot").key).toBe("libraryRoot");
    expect(findSetting("connections").key).toBe("download.connections");
    expect(() => findSetting("nope")).toThrow(UsageError);
  });

  test("values are checked and converted", () => {
    expect(parseValue(findSetting("connections"), "8")).toBe(8);
    expect(() => parseValue(findSetting("connections"), "40")).toThrow(UsageError);
    expect(parseValue(findSetting("regionOrder"), "Europe, USA; Japan")).toEqual(["Europe", "USA", "Japan"]);
    expect(parseValue(findSetting("tool"), "ARIA2C")).toBe("aria2c");
    expect(parseValue(findSetting("libraryRoot"), '"D:\\My Games"')).toBe("D:\\My Games");
    expect(parseValue(findSetting("inboxDirectory"), "default")).toBeNull();
    expect(() => parseValue(findSetting("libraryRoot"), "default")).toThrow(UsageError);
  });

  test("setting a nested value creates its section; resetting it removes the key", () => {
    const config = baseConfig();
    setValue(config, "download.connections", 8);
    expect(config.download).toEqual({ connections: 8 });
    setValue(config, "download.connections", null);
    expect(config.download).toEqual({});
    setValue(config, "inboxDirectory", null);
    expect(config.inboxDirectory).toBeNull();
    expect(validateConfigFile(config)).toEqual([]);
  });
});
