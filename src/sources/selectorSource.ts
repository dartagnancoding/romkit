/**
 * Generic adapter driven by the CSS selectors in the config ("adapter": "selector").
 *
 * Search page:  every `resultItem` element is one result; `title`, `pageLink`,
 *               `region` and `size` are looked up inside it.
 * Game page:    `downloadLink` is looked up and its href (or
 *               `downloadLinkAttribute`) is the URL to download.
 *               With `downloadLink: ":self"` the result's link already is the file.
 *
 * List mode:    a searchUrl without {query} is a page listing every game (e.g. a file
 *               index such as "USA/Game (U) [!].nes"). romkit reads the whole list
 *               and keeps the entries whose name resembles the query, best first.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { ReleasePreferences, ResolvedSystem, SourceConfig, SourceSelectors } from "../config/configTypes";
import { titleSimilarity } from "../identification/fuzzyMatcher";
import { logger } from "../logging/logger";
import { compareReleases } from "../naming/releasePreference";
import { parseRomName, type RomTag } from "../naming/tagParser";
import { compactKey, normalizeTitleForComparison } from "../naming/titleNormalization";
import { formatBytes } from "../util/format";
import { blockedOutcome, detectHttpProblem, explainMissingContent, findChallengeMarker } from "./blockDetector";
import type { FetchedPage, HttpClient } from "./httpClient";
import type { ListPageCache } from "./listPageCache";
import {
  buildSearchUrl,
  type DownloadResolution,
  type SearchOutcome,
  type SearchResult,
  type SourceAdapter,
  type SourceContext,
} from "./sourceAdapter";

/**
 * Special selector value. In `title`/`pageLink`: the result element itself.
 * In `downloadLink`: the result's link is the download, there is no game page.
 */
const SELF_SELECTOR = ":self";

/** List mode: entries scoring below this are not offered. "mega man 3 enhanced" for "mega man 3" scores about 0.68. */
const MINIMUM_LIST_SCORE = 0.6;
const MAX_LIST_RESULTS = 10;

export class SelectorSource implements SourceAdapter {
  readonly name: string;
  private readonly selectors: SourceSelectors;
  private readonly httpClient: HttpClient;
  private readonly system: ResolvedSystem;
  private readonly listCache: ListPageCache | undefined;
  private lastSearchUrl: string | undefined;
  /** No {query} in the URL: the page lists every game and romkit filters it. */
  private readonly isListPage: boolean;

  constructor(
    private readonly sourceConfig: SourceConfig,
    context: SourceContext,
  ) {
    this.name = sourceConfig.name;
    // Config validation guarantees selectors exist for this adapter.
    this.selectors = sourceConfig.selectors!;
    this.httpClient = context.httpClient;
    this.system = context.system;
    this.listCache = context.listCache;
    this.isListPage = !sourceConfig.searchUrl.includes("{query}");
  }

  async search(query: string): Promise<SearchOutcome> {
    const searchUrl = buildSearchUrl(this.sourceConfig, this.system, query);
    this.lastSearchUrl = searchUrl;
    const cachedPage = this.isListPage ? await this.listCache?.read(searchUrl) : null;
    const page: FetchedPage = cachedPage ?? (await this.httpClient.fetchPage(searchUrl));

    const httpProblem = detectHttpProblem(page);
    if (httpProblem) return httpProblem;

    const document = cheerio.load(page.body);
    const resultElements = document(this.selectors.resultItem).toArray();
    // Only a list page that parsed as expected is worth keeping.
    if (this.isListPage && !cachedPage && resultElements.length > 0) await this.listCache?.write(page);

    if (resultElements.length === 0) {
      const marker = findChallengeMarker(page.body);
      if (marker) return blockedOutcome("captcha", `${marker} detected`, page.finalUrl);
      if (this.isListPage) {
        return blockedOutcome("unexpected-page", `the list page has no element matching "${this.selectors.resultItem}"`, page.finalUrl);
      }
      if (this.sourceConfig.noResultsText && page.body.includes(this.sourceConfig.noResultsText)) {
        return { kind: "results", results: [] };
      }
      if (this.sourceConfig.noResultsText) {
        // The site's "no results" text is missing too: the layout probably changed.
        return blockedOutcome(
          "unexpected-page",
          `no element matched "${this.selectors.resultItem}" and the no-results text was not found`,
          page.finalUrl,
        );
      }
      logger.debug(
        `${this.name}: no element matched "${this.selectors.resultItem}". Treating as "no results"; ` +
          `set noResultsText in the config to detect layout changes.`,
      );
      return { kind: "results", results: [] };
    }

    const results: SearchResult[] = [];
    for (const element of resultElements) {
      const titleText = collapseWhitespace(this.selectWithin(document, element, this.selectors.title).first().text());
      const href = this.selectWithin(document, element, this.selectors.pageLink).first().attr("href");
      if (!titleText || !href) {
        logger.debug(`${this.name}: skipping a result without title or link.`);
        continue;
      }
      // List entries are file paths: "USA/Game (U) [!].nes" → title "Game (U) [!]", folder "USA".
      const { title, folder } = this.isListPage ? splitListEntry(titleText) : { title: titleText, folder: undefined };

      const regionTags: string[] = [];
      if (this.selectors.region) {
        const regionText = collapseWhitespace(this.selectWithin(document, element, this.selectors.region).first().text());
        regionTags.push(...splitList(regionText));
      }
      // Titles often carry their own tags, e.g. "Game (USA) (Rev 1)".
      for (const tag of parseRomName(title).tags) {
        if (!regionTags.includes(tag.text)) regionTags.push(tag.text);
      }

      const sizeText = this.selectors.size
        ? formatSize(collapseWhitespace(this.selectWithin(document, element, this.selectors.size).first().text()))
        : undefined;

      results.push({
        sourceName: this.name,
        title,
        folder,
        pageUrl: new URL(href, page.finalUrl).href,
        regionTags,
        sizeText,
      });
    }

    if (results.length === 0) {
      return blockedOutcome(
        "unexpected-page",
        `found ${resultElements.length} result element(s) but none had a title and a link; the selectors may be outdated`,
        page.finalUrl,
      );
    }
    if (this.isListPage) return { kind: "results", results: filterListByQuery(results, query, this.system.preferences) };
    return { kind: "results", results };
  }

  async resolveDownload(result: SearchResult): Promise<DownloadResolution> {
    if (this.selectors.downloadLink === SELF_SELECTOR) {
      return { kind: "ready", downloadUrl: result.pageUrl, referer: this.lastSearchUrl };
    }
    const page = await this.httpClient.fetchPage(result.pageUrl, this.lastSearchUrl);
    const httpProblem = detectHttpProblem(page);
    if (httpProblem) return httpProblem;

    const document = cheerio.load(page.body);
    const attributeName = this.selectors.downloadLinkAttribute ?? "href";
    const linkValue = document(this.selectors.downloadLink).first().attr(attributeName);
    if (!linkValue) {
      return explainMissingContent(page, `download link "${this.selectors.downloadLink}" not found on the game page`);
    }

    return {
      kind: "ready",
      downloadUrl: new URL(linkValue, page.finalUrl).href,
      referer: page.finalUrl,
    };
  }

  private selectWithin(document: cheerio.CheerioAPI, element: AnyNode, selector: string) {
    return selector === SELF_SELECTOR ? document(element) : document(element).find(selector);
  }
}

/**
 * List mode: the entries resembling the query, best match first and, among equal
 * matches, the preferred release first (final USA [!] before prototypes and translations).
 */
export function filterListByQuery(
  results: SearchResult[],
  query: string,
  preferences: ReleasePreferences,
): SearchResult[] {
  return scoreResults(results, query)
    .filter((entry) => entry.score >= MINIMUM_LIST_SCORE)
    .sort((first, second) => compareScored(first, second, preferences))
    .slice(0, MAX_LIST_RESULTS)
    .map((entry) => entry.result);
}

/**
 * Orders results from several sources as one list: best match first, then the
 * preferred release. Nothing is dropped. Without it, results would come grouped by
 * source, and an exact match from the last source would sit below loose ones.
 */
export function sortByRelevance(results: SearchResult[], query: string, preferences: ReleasePreferences): SearchResult[] {
  return scoreResults(results, query)
    .sort((first, second) => compareScored(first, second, preferences))
    .map((entry) => entry.result);
}

interface ScoredResult {
  result: SearchResult;
  score: number;
  tags: RomTag[];
}

function scoreResults(results: SearchResult[], query: string): ScoredResult[] {
  const normalizedQuery = normalizeTitleForComparison(query);
  const compactQuery = compactKey(query);
  return results.map((result) => {
    const { title, tags } = parseRomName(result.title);
    const normalizedTitle = normalizeTitleForComparison(title);
    // "megaman 3" and "Mega Man 3" differ only in spaces.
    const score = compactKey(title) === compactQuery ? 1 : Math.max(titleSimilarity(normalizedQuery, normalizedTitle), containmentScore(normalizedQuery, normalizedTitle));
    return { result, score, tags };
  });
}

/** Array.sort is stable, so equal entries keep the source order. */
function compareScored(first: ScoredResult, second: ScoredResult, preferences: ReleasePreferences): number {
  return second.score - first.score || compareReleases(second.tags, first.tags, preferences);
}

/**
 * Every typed word appears in the title: "sonic cd" → "Sonic the Hedgehog CD" scores 0.8.
 * Titles with fewer extra words score higher, but never as high as an exact match.
 */
function containmentScore(normalizedQuery: string, normalizedTitle: string): number {
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const titleWords = new Set(normalizedTitle.split(" ").filter(Boolean));
  if (queryWords.length === 0 || !queryWords.every((word) => titleWords.has(word))) return 0;
  return MINIMUM_LIST_SCORE + 0.39 * (queryWords.length / titleWords.size);
}

/** "USA/Game (U) [!].nes" → { title: "Game (U) [!]", folder: "USA" } */
export function splitListEntry(text: string): { title: string; folder: string | undefined } {
  const separatorIndex = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const fileName = text.slice(separatorIndex + 1);
  const folder = separatorIndex > 0 ? text.slice(0, separatorIndex) : undefined;
  return { title: fileName.replace(/\.[a-z0-9]{1,5}$/i, "").trim() || fileName, folder };
}

/** Plain byte counts ("393232", as file indexes show them) become "384 KB"; anything else is kept. */
function formatSize(text: string): string | undefined {
  if (text === "") return undefined;
  return /^\d+$/.test(text) ? formatBytes(Number(text)) : text;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** "USA, Europe" or "USA / Europe" → ["USA", "Europe"] */
function splitList(text: string): string[] {
  return text
    .split(/[,/|]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
