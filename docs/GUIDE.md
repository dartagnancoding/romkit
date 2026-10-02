# romkit

A command-line tool (TypeScript + Bun, made for PowerShell on Windows 11) that
downloads, extracts, renames and organizes ROMs into a local library with one
folder per system:

```
E:\ROM\
  Game Boy Advance\Mega Man Zero 4.gba
  PlayStation\Crash Bandicoot.cue
  PlayStation\Crash Bandicoot.bin
  MAME\pacman.zip
```

What it does:

- **download**: searches the sources configured for a system, lets you pick a result, and downloads it with a progress bar.
- **import**: runs a file you downloaded yourself through the same steps.
- **Extraction**: detects zip/rar/7z by the file's magic bytes (not its extension), extracts with your 7-Zip, keeps only the accepted extensions and drops readmes, `.nfo` and the like.
- **Naming**: tries, in order, a CRC32/SHA1 match in a No-Intro/Redump DAT, an editable alias table (`MMZ4` → `Mega Man Zero 4`), and a fuzzy title match. When it is not sure, it asks you.
- **organize**: brings the names in an existing system folder up to the standard, and shows the plan before changing anything.
- **cue/bin**: a `.cue` and its `.bin` tracks are renamed together, and the `.cue` is rewritten to point to the new names.
- **Arcade (MAME)**: romset zips are stored exactly as they are, because the emulator needs their short names.
- **Old dumps**: ROMs without an extension (for example `GE00` inside a GoldenEye zip) are recognized by their header (N64, NES, GBA).

romkit never tries to solve captchas or get past anti-bot pages. When it finds one, it stops, shows the
link, and suggests downloading manually and using `romkit import`.

---

## Installation

Requirements:

- [Bun](https://bun.sh) 1.3 or newer: `powershell -c "irm bun.sh/install.ps1 | iex"`
- [7-Zip](https://www.7-zip.org) (`7z.exe`; the default install path is detected automatically)

```powershell
cd D:\Projetos\romkit
bun install
bun test          # optional: run the tests
```

### Making `romkit` available everywhere

Pick **one** of the two options.

**Option A: `bun link` (runs from source; code edits take effect immediately)**

```powershell
cd D:\Projetos\romkit
bun link
```

`bun link` puts the `romkit` command in `%USERPROFILE%\.bun\bin`, which the Bun installer adds to
your PATH. Open a new PowerShell window and run `romkit --version`. To undo, run `bun unlink` in the
project folder.

**Option B: a standalone `romkit.exe` (no Bun needed to run it)**

```powershell
cd D:\Projetos\romkit
bun run build                                   # creates dist\romkit.exe
New-Item -ItemType Directory -Force "$HOME\bin" | Out-Null
Copy-Item dist\romkit.exe "$HOME\bin\romkit.exe"

# Add $HOME\bin to your user PATH (only needed once):
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$HOME\bin*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$HOME\bin", "User")
}
```

Open a new PowerShell window. After changing the code, run `bun run build` again and copy the new exe.

### First run

```powershell
romkit init                   # creates %APPDATA%\romkit\romkit.config.json
romkit systems add gba        # add systems with suggestions from the built-in catalog
romkit systems add playstation
romkit systems                # list what is configured
```

---

## Commands

| Command | What it does |
|---|---|
| `romkit download <title> [-sys <system>] [--source <name>]` | Search, download, extract, rename, organize |
| `romkit import <path> [-sys <system>] [--delete-source]` | Same flow for a file you downloaded yourself |
| `romkit organize -sys <system> [--dry-run]` | Standardize the names in a system folder |
| `romkit systems` | List configured systems |
| `romkit systems add [name]` | Add a system (with catalog suggestions) |
| `romkit systems remove <id>` | Remove a system from the config (files are not touched) |
| `romkit init` | Create the config file |

Options:

| Option | Meaning |
|---|---|
| `-sys`, `--sys`, `-s`, `--system <x>` | System id or alias. Case and spaces don't matter: `gba`, `"game boy advance"`. Without it, romkit asks. |
| `--dry-run`, `-n` | `organize`: only show the plan |
| `--yes`, `-y` | Accept every name suggestion, even low-confidence ones. When the name is already taken, the file is **skipped**. |
| `--source <name>` | `download`: search only this source |
| `--delete-source` | `import`: delete the original file after a successful import (otherwise it is left untouched) |
| `--keep-temp` | Keep the temporary folder, to inspect what an archive contained |
| `--config <path>` | Use a different config file |
| `--verbose`, `-v` | Show HTTP requests, hashes, 7-Zip commands... |
| `--help`, `-h` / `--version` | Help / version |

Option names are case-insensitive (`-Sys` works). Title words don't need quotes:
`romkit download mega man zero 4 -sys gba`.

Examples:

```powershell
romkit download MMZ4 -sys gba                 # alias → searches "Mega Man Zero 4"
romkit import "$HOME\Downloads\game.7z" -sys psx
romkit organize -sys gba --dry-run
romkit organize -sys gba
```

### What happens when...

- **There are no results**: romkit says so and lists which sources it searched.
- **There are several results**: it shows a numbered list with title, tags and size. Type the number, or `0` to cancel.
- **An archive holds several valid ROMs**: it asks which one to keep. The rest are discarded.
- **No valid ROM is left after filtering**: romkit warns you and moves nothing.
- **Confidence is low**: it shows the suggestion and its alternatives. Press `Enter` to accept, a number to pick an alternative, `e` to type a name, or `s` to skip.
- **The name is already in the library**: choose `[o]` overwrite, `[s]` skip, or `[k]` keep both (the new file gets ` (2)` added).
- **A captcha, a block (HTTP 403/429/503) or an unexpected page appears**: romkit stops and prints the link plus the `romkit import` command to run after you download manually.

Exit codes: `0` success, `1` error, `2` invalid command line, `130` cancelled.

---

## Configuration

The config file is looked up in this order:

1. `--config <path>`
2. the `ROMKIT_CONFIG` environment variable
3. `%APPDATA%\romkit\romkit.config.json`

So the command works from any folder. A complete example is in
[`romkit.config.example.json`](../romkit.config.example.json).

```jsonc
{
  "libraryRoot": "E:\\ROM",                         // one subfolder per system
  "sevenZipPath": "C:\\Program Files\\7-Zip\\7z.exe",
  "tempDirectory": null,                            // null = %TEMP%\romkit
  "logFile": null,                                  // null = %LOCALAPPDATA%\romkit\romkit.log
  "aliasesFile": "romkit.aliases.json",             // relative to the config folder
  "http": { "userAgent": "...", "timeoutMs": 20000, "delayBetweenRequestsMs": 1500 },
  "matching": { "autoAcceptThreshold": 0.9 },       // below this confidence, romkit asks
  "sources": [ /* see "Sources" */ ],
  "systems": [ /* see "Adding a system" */ ]
}
```

Relative paths (`datPath`, `aliasesFile`, `tempDirectory`...) are resolved from the folder that
holds the config file. Folders in `systems[].folder` are relative to `libraryRoot`.

Folders in `libraryRoot` that do not belong to a configured system (for example `BIOS` or `dump`) are
never touched.

### Log file

Every run is appended to `%LOCALAPPDATA%\romkit\romkit.log` (or `logFile`), debug details included,
even without `--verbose`. Look there first when something goes wrong.

---

## Adding a system

The easy way is `romkit systems add <name>`. It looks the name up in the built-in catalog of about 40
systems, suggests the id, aliases, extensions and which No-Intro/Redump DAT to download, and asks
you to confirm or edit each field. It then saves the config and creates the folder.

Folders use the full console name (`E:\ROM\Mega Drive`, `E:\ROM\GameCube`), never abbreviations.
That is what you look for in Explorer, and it avoids mixing up similar abbreviations (DS/3DS, PS/PS2).
The short id (`MD`, `GC`) is only what you type after `-sys`.

To do it by hand, add an entry to `systems`:

```jsonc
{
  "id": "GBA",                                   // used with -sys; letters, digits, - and _
  "name": "Game Boy Advance",
  "aliases": ["gba", "game boy advance"],        // other names accepted by -sys
  "folder": "Game Boy Advance",                  // under libraryRoot
  "extensions": [".gba"],                        // files that are the game itself
  "datPath": "dats\\Nintendo - Game Boy Advance.dat",   // optional
  "naming": { "template": "{title}", "keepTags": [] },
  "compressToZip": false,                        // true = store each ROM as <name>.zip
  "sources": ["ExampleROMs"]                     // names from the top-level "sources", in search order
}
```

Notes:

- **Disc systems**: list `.cue` in `extensions`. You don't need to list `.bin`: the tracks referenced by
  the cue are found automatically. A `.bin` without a `.cue` is only accepted when `.bin` itself is in the
  list (for example Mega Drive cartridges).
- **DATs**: download them in XML format from No-Intro (DAT-o-MATIC) for cartridges, or from Redump for
  discs. A system without a DAT still works, but names then come from the file name or from aliases.
- **compressToZip** applies to `download` and `import`. `organize` only renames, and ignores zips.
- **Arcade mode** (`"mode": "arcade"`, used by the MAME catalog entry): each `.zip`/`.7z` is a romset
  that MAME finds by its exact short name (`sf2.zip`). romkit moves it into the folder unchanged, with
  no extraction, renaming or identification. It warns you when a name does not look like a short name
  (`Street Fighter II.zip`). `organize` skips these systems.
- **Files without an extension**: inside archives, files whose extension is not accepted are checked by
  header. N64 (all three byte orders), NES (iNES) and GBA ROMs are recognized and get the right extension.
- **`import` hints**: the name of the folder that holds the file is used as an extra hint. This helps
  when the file name is cryptic (`gmb-tloztpu.iso` inside `The_Legend_Of_Zelda_Twilight_Princess...`).

### Naming

`naming.template` builds the final name. These tokens are available:

| Token | Value |
|---|---|
| `{title}` | Title without tags: `Mega Man Zero 4` |
| `{tags}` | Only the tags matched by `keepTags`, with their brackets: `(Rev 1) [T-Por]` |
| `{region}` | Region tags: `USA, Europe` |
| `{system}` | The system id |

`keepTags` takes case-insensitive patterns where `*` is a wildcard. They are matched against the text
inside the brackets:

```jsonc
"naming": { "template": "{title} {tags}", "keepTags": ["Rev *", "Disc *", "T-Por*"] }
// "Game (USA) (Rev 1) [T-Por by X]" → "Game (Rev 1) [T-Por by X]"
```

Empty brackets left behind by a missing value are removed, and the result is always made safe as a
Windows file name:

- `:` becomes ` - `;
- `< > | ? *` are removed;
- reserved names like `CON` get a `_` appended;
- trailing dots and spaces are removed.

### Aliases

`romkit.aliases.json`, next to the config file:

```json
{
  "*":   { "SMB3": "Super Mario Bros. 3" },
  "GBA": { "MMZ4": "Mega Man Zero 4" }
}
```

`"*"` applies to every system. Matching ignores case and spaces. Aliases are used both to expand
what you search for (`romkit download MMZ4`) and to identify files (`MMZ4.gba`). If a DAT is
configured, the title is spelled the way the DAT spells it.

### How identification decides

| Method | When | Confidence |
|---|---|---|
| hash | CRC32/SHA1 found in the DAT (for a cue sheet, the first track is hashed) | 100% |
| alias | a name matches the alias table | 95% |
| fuzzy | a name resembles a DAT title | similarity score |
| filename | none of the above, no DAT: the name has release tags such as `(USA)` | 90% |
| filename | none of the above, no DAT: the name has no tags (it may be a nickname) | 60% |
| filename | none of the above, but a DAT exists and does not know the game | 40% |

Anything below `matching.autoAcceptThreshold` (default 0.9) is shown to you for confirmation.

---

## Sources

Sources are defined once at the top level. There are two ways to connect a source to systems, and
they can be combined:

- **On the source**: `"systems": ["PS1", "PS2"]`, or `"systems": ["*"]` for every system. This is the
  quickest way when a site covers many consoles.
- **On the system**: `"sources": ["SiteA", "SiteB"]` in the system entry, which also sets the search order.

A system searches its own `sources` list first, then the sources that list it in their `systems`, in
config order. A site without Nintendo games, for example, is simply left out of GBA and SNES.

```jsonc
{
  "name": "ExampleROMs",
  "searchUrl": "https://roms.example.invalid/{system}/search?q={query}",
  "systemParams": { "PS1": "playstation", "MD": "mega-drive" },  // fills {system} per system id
  "requiresJavaScript": false,
  "selectors": {
    "resultItem": ".result-row",       // one element per result on the search page
    "title": "a.result-title",         // inside resultItem (":self" = the element itself)
    "pageLink": "a.result-title",      // inside resultItem; its href is the game page
    "region": ".result-region",        // optional
    "size": ".result-size",            // optional
    "downloadLink": "a#download",      // on the game page
    "downloadLinkAttribute": "href"    // optional, default "href"
  },
  "noResultsText": "No games found"    // recommended, see below
}
```

How romkit scrapes:

- **Requests**: it uses `fetch` with your User-Agent, a timeout, and a pause of
  `delayBetweenRequestsMs` between requests to the same host.
- **`noResultsText`** lets romkit tell "nothing found" apart from "the page changed". Without it, a
  page with no matching element counts as zero results. With it, such a page counts as unexpected
  and romkit stops.
- **`requiresJavaScript: true`** marks a site that only shows content through JavaScript. romkit does
  not scrape these (there is no headless browser). It prints the search link so you can download in
  your browser and then use `import`.

### Writing a source adapter

When CSS selectors are not enough (a JSON API, a search that needs a POST, several steps before the
link), write an adapter:

1. Create `src/sources/custom/mySiteSource.ts` and export a factory that returns a `SourceAdapter`
   (see `src/sources/sourceAdapter.ts`):

   ```ts
   import type { SourceConfig } from "../../config/configTypes";
   import { detectHttpProblem, explainMissingContent } from "../blockDetector";
   import { buildSearchUrl, type SourceAdapter, type SourceContext } from "../sourceAdapter";

   export function createMySiteSource(sourceConfig: SourceConfig, context: SourceContext): SourceAdapter {
     return {
       name: sourceConfig.name,
       async search(query) {
         const page = await context.httpClient.fetchPage(buildSearchUrl(sourceConfig, context.system, query));
         const httpProblem = detectHttpProblem(page);   // 403/429/503 and other non-2xx
         if (httpProblem) return httpProblem;
         // ...parse page.body; if the expected content is missing:
         //    return explainMissingContent(page, "what was missing");
         return { kind: "results", results: [/* { sourceName, title, pageUrl, regionTags, sizeText } */] };
       },
       async resolveDownload(result) {
         // ...find the real file URL
         return { kind: "ready", downloadUrl: "https://...", referer: result.pageUrl };
       },
     };
   }
   ```

2. Register it in `src/sources/custom/index.ts`:

   ```ts
   export const customAdapterFactories = {
     "example-json-api": createExampleJsonApiSource,
     "my-site": createMySiteSource,
   };
   ```

3. Use it in the config with `"adapter": "my-site"`. `selectors` are optional for custom adapters. Put
   any extra settings under `"options": { ... }`; you can read them from `sourceConfig.options`.

Rules for adapters:

- Always go through `context.httpClient`, so the User-Agent, timeout and delay apply.
- Never try to solve or get around captchas or protections. Return a `BlockedOutcome` (helpers in
  `blockDetector.ts`) and romkit will show the link to the user.

`src/sources/custom/exampleJsonApiSource.ts` is a complete example for a fictional JSON API.

If you use option B, rebuild the exe after adding an adapter (`bun run build`).

---

## Project layout

```
src/
  index.ts                  entry point (exit codes)
  cli/                      argument parser, router, prompts, progress bar, commands/
  config/                   config types, validation, loading, system lookup
  catalog/                  built-in system catalog used by `systems add`
  sources/                  HTTP client, block detection, selector adapter, custom/ adapters
  download/                 streaming downloader, temporary workspace
  extraction/               magic-byte detection, 7-Zip, cue sheets, ROM unit grouping
  identification/           hashing, DAT index, aliases, fuzzy matching, identifier
  naming/                   tag parsing, normalization, template formatting, file name sanitizing
  organization/             placing files in the library, conflicts, organize plan
  workflow/                 the shared download/import pipeline
  logging/                  console + file logger
tests/                      bun test
```

Development commands:

```powershell
bun test             # tests
bun run typecheck    # TypeScript check
bun run start -- systems --config .\romkit.config.example.json
bun run build        # dist\romkit.exe
```
