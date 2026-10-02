/**
 * Contract every source adapter implements.
 *
 * An adapter knows how to search one site and how to find the real download URL
 * for a chosen result. It never downloads the file itself (src/download does),
 * and it never tries to get past captchas or anti-bot pages: it reports them as
 * a BlockedOutcome so the CLI can stop and show the link for a manual download.
 */

import type { ResolvedSystem, SourceConfig } from "../config/configTypes";
import type { HttpClient } from "./httpClient";

export interface SearchResult {
  sourceName: string;
  title: string;
  /** Game page on the site; shown to the user when something goes wrong. */
  pageUrl: string;
  /** Region/version tags, e.g. ["USA", "Rev 1"]. */
  regionTags: string[];
  /** Size as the site shows it, e.g. "8.2 MB". */
  sizeText?: string;
}

export interface BlockedOutcome {
  kind: "blocked";
  reason: "captcha" | "http-status" | "unexpected-page";
  /** Human readable detail, e.g. "HTTP 403" or "selector .result-row not found". */
  detail: string;
  /** Page the user should open in a browser to continue manually. */
  pageUrl: string;
}

export type SearchOutcome = { kind: "results"; results: SearchResult[] } | BlockedOutcome;

export type DownloadResolution =
  | { kind: "ready"; downloadUrl: string; referer?: string; suggestedFileName?: string }
  | BlockedOutcome;

export interface SourceAdapter {
  readonly name: string;
  search(query: string): Promise<SearchOutcome>;
  /** Opens the chosen result's page and finds the actual download URL. */
  resolveDownload(result: SearchResult): Promise<DownloadResolution>;
}

/** What an adapter receives when created. */
export interface SourceContext {
  httpClient: HttpClient;
  system: ResolvedSystem;
}

export type SourceAdapterFactory = (sourceConfig: SourceConfig, context: SourceContext) => SourceAdapter;

/** Fills {query} and {system} in a source's search URL. */
export function buildSearchUrl(sourceConfig: SourceConfig, system: ResolvedSystem, query: string): string {
  const systemParam = sourceConfig.systemParams?.[system.id] ?? "";
  return sourceConfig.searchUrl
    .replaceAll("{query}", encodeURIComponent(query))
    .replaceAll("{system}", encodeURIComponent(systemParam));
}
