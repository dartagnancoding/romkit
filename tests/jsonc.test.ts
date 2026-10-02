import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config/configLoader";
import type { ConfigFile } from "../src/config/configTypes";
import { validateConfigFile } from "../src/config/configValidation";
import { locateSyntaxError, parseJsonWithComments, stripJsonComments } from "../src/config/jsonc";
import { RomkitError } from "../src/errors";

describe("stripJsonComments", () => {
  test("removes line and block comments but keeps // inside strings", () => {
    const text = [
      "{",
      '  "url": "https://site.example/search?q={query}", // the search page',
      "  /* a block",
      "     comment */",
      '  "path": "C:\\\\ROM" // backslashes are escaped',
      "}",
    ].join("\n");
    expect(JSON.parse(stripJsonComments(text))).toEqual({ url: "https://site.example/search?q={query}", path: "C:\\ROM" });
  });

  test("keeps line count so error lines still match the file", () => {
    const text = "{\n/* one\ntwo */\n\"a\": 1\n}";
    expect(stripJsonComments(text).split("\n")).toHaveLength(5);
  });

  test("removes trailing commas outside strings only", () => {
    expect(JSON.parse(stripJsonComments('{ "list": [1, 2,], "text": "a,]", }'))).toEqual({ list: [1, 2], text: "a,]" });
  });

  test("escaped quotes do not end a string", () => {
    expect(JSON.parse(stripJsonComments('{ "a": "say \\"hi\\" // not a comment" }'))).toEqual({ a: 'say "hi" // not a comment' });
  });
});

describe("parse errors", () => {
  test("locates a missing comma", () => {
    expect(locateSyntaxError('{\n  "a": 1\n  "b": 2\n}')).toEqual({ line: 3, column: 3 });
  });

  test("locates a single backslash in a Windows path", () => {
    const location = locateSyntaxError('{\n  "path": "C:\\ROM\n}');
    expect(location?.line).toBe(2);
  });

  test("valid JSON has no error location", () => {
    expect(locateSyntaxError('{ "a": [1, true, null, "x"] }')).toBeNull();
  });

  test("the error message names the line", () => {
    expect(() => parseJsonWithComments('{\n  "a": 1\n  "b": 2\n}', "romkit.config.json")).toThrow(/line 3/);
    expect(() => parseJsonWithComments("{", "x.json")).toThrow(RomkitError);
  });
});

describe("source systems lists", () => {
  const baseConfig = (sources: ConfigFile["sources"], gbaSources: string[] = []): ConfigFile => ({
    libraryRoot: "E:/ROM",
    sevenZipPath: "C:/7z.exe",
    sources,
    systems: [
      { id: "GBA", folder: "Game Boy Advance", extensions: [".gba"], sources: gbaSources },
      { id: "PS1", folder: "PlayStation", extensions: [".cue"] },
    ],
  });
  const linkOnly = (name: string, systems: string[]) => ({ name, searchUrl: `https://${name}.example/?q={query}`, requiresJavaScript: true, systems });

  test('["*"] adds the source to every system', () => {
    const config = resolveConfig(baseConfig([linkOnly("Everywhere", ["*"])]), "C:/romkit/romkit.config.json");
    expect(config.systems.map((system) => system.sourceNames)).toEqual([["Everywhere"], ["Everywhere"]]);
  });

  test("a system's own list comes first, opt-in sources follow without duplicates", () => {
    const sources = [linkOnly("OptIn", ["gba"]), linkOnly("Listed", [])];
    const config = resolveConfig(baseConfig(sources, ["Listed", "OptIn"]), "C:/romkit/romkit.config.json");
    expect(config.systems[0]!.sourceNames).toEqual(["Listed", "OptIn"]);
    expect(config.systems[1]!.sourceNames).toEqual([]);
  });

  test("unknown system ids and missing {system} params are reported", () => {
    const problems = validateConfigFile(
      baseConfig([
        linkOnly("Typo", ["GBAA"]),
        { ...linkOnly("PerSystem", ["*"]), searchUrl: "https://x.example/{system}?q={query}", systemParams: { GBA: "gba" } },
      ]),
    );
    expect(problems.some((problem) => problem.includes('"GBAA" is not a configured system id'))).toBe(true);
    expect(problems.some((problem) => problem.includes("no systemParams entry for: PS1"))).toBe(true);
  });
});
