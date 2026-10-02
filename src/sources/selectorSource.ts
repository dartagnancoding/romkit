/**
 * Generic adapter driven by the CSS selectors in the config ("adapter": "selector").
 *
 * Search page:  every `resultItem` element is one result; `title`, `pageLink`,
 *               `region` and `size` are looked up inside it.
 * Game page:    `downloadLink` is looked up and its href (or
 *               `downloadLinkAttribute`) is the URL to download.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { ResolvedSystem, SourceConfig, SourceSelectors } from "../config/configTypes";
import { logger } from "../logging/logger";
import { parseRomName } from "../naming/tagParser";
import { blockedOutcome, detectHttpProblem, explainMissingContent, findChallengeMarker } from "./blockDetector";
import type { HttpClient } from "./httpClient";
import {
  buildSearchUrl,
  type DownloadResolution,
  type SearchOutcome,
  type SearchResult,
  type SourceAdapter,
  type SourceContext,
} from "./sourceAdapter";

/** Special selector value meaning "the result element itself". */
const SELF_SELECTOR = ":self";

export class SelectorSource implements SourceAdapter {
  readonly name: string;
  private readonly selectors: SourceSelectors;
  private readonly httpClient: HttpClient;
  private readonly system: ResolvedSystem;
  private lastSearchUrl: string | undefined;

  constructor(
    private readonly sourceConfig: SourceConfig,
    context: SourceContext,
  ) {
    this.name = sourceConfig.name;
    // Config validation guarantees selectors exist for this adapter.
    this.selectors = sourceConfig.selectors!;
    this.httpClient = context.httpClient;
    this.system = context.system;
  }

  async search(query: string): Promise<SearchOutcome> {
    const searchUrl = buildSearchUrl(this.sourceConfig, this.system, query);
    this.lastSearchUrl = searchUrl;
    const page = await this.httpClient.fetchPage(searchUrl);

    const httpProblem = detectHttpProblem(page);
    if (httpProblem) return httpProblem;

    const document = cheerio.load(page.body);
    const resultElements = document(this.selectors.resultItem).toArray();

    if (resultElements.length === 0) {
      const marker = findChallengeMarker(page.body);
      if (marker) return blockedOutcome("captcha", `${marker} detected`, page.finalUrl);
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
      const title = collapseWhitespace(this.selectWithin(document, element, this.selectors.title).first().text());
      const href = this.selectWithin(document, element, this.selectors.pageLink).first().attr("href");
      if (!title || !href) {
        logger.debug(`${this.name}: skipping a result without title or link.`);
        continue;
      }

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
        ? collapseWhitespace(this.selectWithin(document, element, this.selectors.size).first().text()) || undefined
        : undefined;

      results.push({
        sourceName: this.name,
        title,
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
    return { kind: "results", results };
  }

  async resolveDownload(result: SearchResult): Promise<DownloadResolution> {
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
