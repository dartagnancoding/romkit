import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedSystem, SourceConfig } from "../src/config/configTypes";
import { fileNameFromUrl } from "../src/download/downloader";
import type { HttpClient } from "../src/sources/httpClient";
import { ListPageCache } from "../src/sources/listPageCache";
import { SelectorSource, sortByRelevance, splitListEntry } from "../src/sources/selectorSource";

const LIST_URL = "https://example.invalid/view_archive.php?archive=ROMS.zip";

/** Trimmed copy of an archive.org file index. */
const LIST_PAGE = `
<table class="archext">
<tr><th>file<th>as jpg<th>timestamp<th>size</tr>
${[
  "Hacks/Afro Man (Mega Man 3 Hack).nes",
  "Hacks/Mega Man 3 Enhanced (Hack).nes",
  "PC10/Mega Man 3 (PC10) [!].nes",
  "Translated/Mega Man 3 (U) [T-Port].nes",
  "USA/Mega Man 2 (U) [!].nes",
  "USA/Mega Man 3 (Prototype) (U) [!].nes",
  "USA/Mega Man 3 (U) [!].nes",
  "USA/Super Mario Bros. 3 (U) (PRG1) [!].nes",
]
  .map((path) => `<tr><td><a href="//example.invalid/download/ROMS.zip/${encodeURIComponent(path)}">${path}</a><td><td>2003-01-15 23:35<td id="size">393232</tr>`)
  .join("\n")}
</table>`;

const NES = { id: "NES", preferences: { regionOrder: ["USA", "World", "Europe", "Japan"], translations: "avoid" } } as ResolvedSystem;

const LIST_SOURCE: SourceConfig = {
  name: "MyList",
  searchUrl: LIST_URL,
  selectors: { resultItem: "table.archext tr", title: "td a", pageLink: "td a", size: "td#size", downloadLink: ":self" },
};

function sourceServing(body: string, sourceConfig = LIST_SOURCE): SelectorSource {
  const httpClient = {
    fetchPage: async (url: string) => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", body }),
  } as unknown as HttpClient;
  return new SelectorSource(sourceConfig, { httpClient, system: NES });
}

describe("selector source, list mode", () => {
  test("keeps only entries resembling the query, the preferred release first", async () => {
    const outcome = await sourceServing(LIST_PAGE).search("megaman 3");
    if (outcome.kind !== "results") throw new Error(outcome.detail);
    expect(outcome.results.map((result) => `${result.folder}/${result.title}`)).toEqual([
      "USA/Mega Man 3 (U) [!]",
      "PC10/Mega Man 3 (PC10) [!]",
      "Translated/Mega Man 3 (U) [T-Port]",
      "USA/Mega Man 3 (Prototype) (U) [!]",
    ]);
    expect(outcome.results[0]!.regionTags).toEqual(["U", "!"]);
    expect(outcome.results[0]!.sizeText).toBe("384 KB");
  });

  test("a query whose words all appear in a longer title still finds it", async () => {
    const page = `<table class="archext">${["Sonic Spinball.chd", "Sonic the Hedgehog CD.chd", "Snatcher.chd"]
      .map((name) => `<tr><td><a href="${encodeURIComponent(name)}">${name}</a></tr>`)
      .join("")}</table>`;
    const outcome = await sourceServing(page).search("sonic cd");
    if (outcome.kind !== "results") throw new Error(outcome.detail);
    expect(outcome.results.map((result) => result.title)).toEqual(["Sonic the Hedgehog CD"]);
  });

  test('downloadLink ":self" downloads the result link without opening another page', async () => {
    const source = sourceServing(LIST_PAGE);
    const outcome = await source.search("Mega Man 3");
    if (outcome.kind !== "results") throw new Error(outcome.detail);
    const resolution = await source.resolveDownload(outcome.results[0]!);
    expect(resolution).toEqual({
      kind: "ready",
      downloadUrl: "https://example.invalid/download/ROMS.zip/USA%2FMega%20Man%203%20(U)%20%5B!%5D.nes",
      referer: LIST_URL,
    });
  });

  test("a list page without the expected rows is reported, not treated as no results", async () => {
    const outcome = await sourceServing("<html><body>Maintenance</body></html>").search("Mega Man 3");
    expect(outcome.kind).toBe("blocked");
  });

  test("splitListEntry separates the folder and drops the extension", () => {
    expect(splitListEntry("USA/Mega Man 3 (U) [!].nes")).toEqual({ title: "Mega Man 3 (U) [!]", folder: "USA" });
    expect(splitListEntry("Tetris (World).gb")).toEqual({ title: "Tetris (World)", folder: undefined });
  });
});

describe("results from several sources", () => {
  test("are ranked together: an exact match from a later source comes first", () => {
    const fromSourceC = { sourceName: "PS1 C", title: "Crash Bash & Spyro - Year of the Dragon (USA) (Demo)", pageUrl: "https://example.invalid/c", regionTags: [] };
    const fromSourceS = { sourceName: "PS1 S", title: "Spyro the Dragon (USA)", pageUrl: "https://example.invalid/s", regionTags: [] };
    const ranked = sortByRelevance([fromSourceC, fromSourceS], "spyro the dragon", NES.preferences);
    expect(ranked.map((result) => result.sourceName)).toEqual(["PS1 S", "PS1 C"]);
  });
});

describe("list page cache", () => {
  test("a list page is fetched once and then read from the cache; a broken page is not cached", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "romkit-test-"));
    try {
      let fetchCount = 0;
      let body = "<html>Maintenance</html>";
      const httpClient = {
        fetchPage: async (url: string) => {
          fetchCount++;
          return { requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", body };
        },
      } as unknown as HttpClient;
      const source = () => new SelectorSource(LIST_SOURCE, { httpClient, system: NES, listCache: new ListPageCache(cacheDirectory) });

      expect((await source().search("Mega Man 3")).kind).toBe("blocked");
      body = LIST_PAGE;
      expect((await source().search("Mega Man 3")).kind).toBe("results");
      const cached = await source().search("Mega Man 2");
      expect(fetchCount).toBe(2);
      if (cached.kind !== "results") throw new Error(cached.detail);
      expect(cached.results[0]!.title).toBe("Mega Man 2 (U) [!]");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});

describe("fileNameFromUrl", () => {
  test("a path inside an archive keeps only the file name", () => {
    expect(fileNameFromUrl("https://example.invalid/ROMS.zip/USA%2FMega%20Man%203%20(U)%20%5B!%5D.nes")).toBe("Mega Man 3 (U) [!].nes");
    expect(fileNameFromUrl("https://example.invalid/files/Game.zip")).toBe("Game.zip");
  });
});
