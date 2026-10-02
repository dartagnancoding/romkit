/**
 * EXAMPLE custom adapter for a fictional site with a JSON search API.
 * It exists to show how to write an adapter when CSS selectors are not enough;
 * copy it as a starting point (see "Writing a source adapter" in the README).
 *
 * The fictional API answers  GET {searchUrl}  with:
 *   { "items": [ { "name": "...", "page": "https://...", "region": "USA",
 *                  "sizeBytes": 8388608, "download": "https://..." } ] }
 *
 * Config entry:
 *   { "name": "ExampleApi", "adapter": "example-json-api",
 *     "searchUrl": "https://api.example.invalid/search?q={query}&platform={system}",
 *     "systemParams": { "GBA": "gba" } }
 */

import type { SourceConfig } from "../../config/configTypes";
import { formatBytes } from "../../util/format";
import { blockedOutcome, detectHttpProblem, explainMissingContent } from "../blockDetector";
import {
  buildSearchUrl,
  type DownloadResolution,
  type SearchOutcome,
  type SearchResult,
  type SourceAdapter,
  type SourceContext,
} from "../sourceAdapter";

interface ExampleApiItem {
  name: string;
  page: string;
  region?: string;
  sizeBytes?: number;
  download: string;
}

export function createExampleJsonApiSource(sourceConfig: SourceConfig, context: SourceContext): SourceAdapter {
  // The search response already contains download URLs; remember them by page URL
  // so resolveDownload does not need a second request.
  const downloadUrlByPageUrl = new Map<string, string>();

  return {
    name: sourceConfig.name,

    async search(query: string): Promise<SearchOutcome> {
      const page = await context.httpClient.fetchPage(buildSearchUrl(sourceConfig, context.system, query));
      const httpProblem = detectHttpProblem(page);
      if (httpProblem) return httpProblem;

      let items: ExampleApiItem[];
      try {
        items = (JSON.parse(page.body) as { items: ExampleApiItem[] }).items;
        if (!Array.isArray(items)) throw new Error("missing items");
      } catch {
        // Got HTML (or anything else) instead of JSON: probably a challenge page.
        return explainMissingContent(page, "the API did not return the expected JSON");
      }

      const results: SearchResult[] = items.map((item) => {
        downloadUrlByPageUrl.set(item.page, item.download);
        return {
          sourceName: sourceConfig.name,
          title: item.name,
          pageUrl: item.page,
          regionTags: item.region ? [item.region] : [],
          sizeText: item.sizeBytes ? formatBytes(item.sizeBytes) : undefined,
        };
      });
      return { kind: "results", results };
    },

    async resolveDownload(result: SearchResult): Promise<DownloadResolution> {
      const downloadUrl = downloadUrlByPageUrl.get(result.pageUrl);
      if (!downloadUrl) return blockedOutcome("unexpected-page", "no download URL for this result", result.pageUrl);
      return { kind: "ready", downloadUrl, referer: result.pageUrl };
    },
  };
}
