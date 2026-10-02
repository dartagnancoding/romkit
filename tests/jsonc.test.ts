import { describe, expect, test } from "bun:test";
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
