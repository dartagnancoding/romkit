/**
 * Shapes of the config file (as written by the user) and of the resolved config
 * (defaults applied, paths made absolute) that the rest of the code uses.
 */

// ---------------------------------------------------------------------------
// File format: romkit.config.json
// ---------------------------------------------------------------------------

export interface HttpSettings {
  userAgent: string;
  /** Maximum wait for a page, or for the next chunk of a download. */
  timeoutMs: number;
  /** Minimum pause between two requests to the same host. */
  delayBetweenRequestsMs: number;
}

export interface SourceSelectors {
  /** Matches each result row on the search page. */
  resultItem: string;
  /** Inside a result row. Use ":self" when the row element itself holds the value. */
  title: string;
  /** Inside a result row: the link to the game page (its href is used). */
  pageLink: string;
  /** Optional, inside a result row. */
  region?: string | null;
  /** Optional, inside a result row. */
  size?: string | null;
  /** On the game page: the element holding the actual download URL. */
  downloadLink: string;
  /** Attribute read from downloadLink. Defaults to "href". */
  downloadLinkAttribute?: string | null;
}

export interface SourceConfig {
  name: string;
  /** Adapter implementation. Defaults to "selector" (generic CSS-selector scraper). */
  adapter?: string;
  /** Search URL with {query} and optionally {system} placeholders. */
  searchUrl: string;
  /**
   * Site needs JavaScript to show results. Such sources are never scraped:
   * romkit shows the search link so you can download manually and use `import`.
   */
  requiresJavaScript?: boolean;
  selectors?: SourceSelectors;
  /** Text shown by the site when nothing matched; lets romkit tell "no results" from "broken page". */
  noResultsText?: string | null;
  /**
   * Systems that use this source, by id, or ["*"] for every system. This is an
   * alternative to listing the source in each system's "sources"; both can be combined.
   */
  systems?: string[];
  /** Per-system value for the {system} placeholder, keyed by system id, e.g. { "PS1": "psx" }. */
  systemParams?: Record<string, string>;
  /** Free-form settings for custom adapters. */
  options?: Record<string, unknown>;
}

export interface NamingSettings {
  /** Defaults to "{title}". See src/naming/nameFormatter.ts for tokens. */
  template: string;
  /** Wildcard patterns of tags to keep, e.g. ["Rev *", "T-Por*"]. */
  keepTags: string[];
}

/**
 * "standard": archives are extracted, ROMs are identified and renamed.
 * "arcade":   the archive IS the game (MAME/FBNeo romsets such as "sf2.zip"); it is
 *             never extracted or renamed, because the emulator looks it up by that exact name.
 */
export type SystemMode = "standard" | "arcade";

export interface SystemConfig {
  id: string;
  /** Defaults to "standard". */
  mode?: SystemMode;
  /** Friendly name. Defaults to the id. */
  name?: string;
  aliases?: string[];
  /** Folder for this system, relative to libraryRoot (or absolute). */
  folder: string;
  /** Accepted ROM extensions, e.g. [".gba"] or [".cue", ".chd"]. */
  extensions: string[];
  /** No-Intro / Redump DAT file (XML). Relative paths are resolved from the config folder. */
  datPath?: string | null;
  naming?: Partial<NamingSettings>;
  /** Store each ROM as a .zip in the library instead of the raw file. */
  compressToZip?: boolean;
  /** Names of the sources (from the top-level "sources" list) to search, in order. */
  sources?: string[];
}

export interface ConfigFile {
  libraryRoot: string;
  sevenZipPath: string;
  tempDirectory?: string | null;
  logFile?: string | null;
  aliasesFile?: string | null;
  http?: Partial<HttpSettings>;
  matching?: { autoAcceptThreshold?: number };
  sources?: SourceConfig[];
  systems: SystemConfig[];
}

// ---------------------------------------------------------------------------
// Resolved config used at runtime
// ---------------------------------------------------------------------------

export interface ResolvedSystem {
  id: string;
  mode: SystemMode;
  name: string;
  aliases: string[];
  folderPath: string;
  /** Lowercase, each starting with ".". */
  extensions: string[];
  datPath: string | null;
  naming: NamingSettings;
  compressToZip: boolean;
  sourceNames: string[];
}

export interface ResolvedConfig {
  configPath: string;
  configDirectory: string;
  libraryRoot: string;
  sevenZipPath: string;
  tempDirectory: string;
  logFile: string;
  aliasesFilePath: string;
  http: HttpSettings;
  /** Identification confidence (0..1) at or above which names are accepted without asking. */
  autoAcceptThreshold: number;
  sources: SourceConfig[];
  systems: ResolvedSystem[];
  /** The file exactly as read, so commands like `systems add` can modify and save it. */
  rawFile: ConfigFile;
}

export const DEFAULT_HTTP_SETTINGS: HttpSettings = {
  userAgent: "romkit/0.1 (personal ROM library manager)",
  timeoutMs: 20_000,
  delayBetweenRequestsMs: 1_500,
};

export const DEFAULT_NAMING: NamingSettings = { template: "{title}", keepTags: [] };
export const DEFAULT_AUTO_ACCEPT_THRESHOLD = 0.9;
export const DEFAULT_ALIASES_FILE_NAME = "romkit.aliases.json";
