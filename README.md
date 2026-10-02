# romkit

*[Leia em português](README.pt-BR.md)*

Something I built to help me organize, and grow, my retro game library.

`romkit` is a small command-line tool (TypeScript + Bun, made for PowerShell on Windows). Drop the
games you dumped into a folder, and it works out which console each one is for, extracts it, gives it
a clean name and puts it in the right folder:

```
E:\ROM\
  Game Boy Advance\Mega Man Zero 4.gba
  PlayStation\Crash Bandicoot.cue
  PlayStation\Crash Bandicoot.bin
  MAME\pacman.zip
```

## The easy way: the inbox folder

1. Put your files in `Downloads\dump`: zip, rar, 7z, ISO, cue/bin, split RARs...
2. Double-click `Organizar dump.bat`.
3. romkit shows where each file will go and asks before moving anything.

It works out the console:

- **from the subfolder name**, if there is one (`dump\snes\...`);
- **from the extension** (`.gba`, `.sfc`...);
- **from the file header, when the extension is not enough.** An `.iso` can be GameCube, Wii or PS2, and the header tells which. This works even inside a zip, without extracting everything.

A PS1 `.bin` without a `.cue` gets a generated `.cue`.

The `.bat` is in [`scripts/`](scripts/Organizar%20dump.bat). Copy it wherever you like.

## What else it does

- **Names**: finds the right name using No-Intro/Redump DATs, a nickname list (`MMZ4` → `Mega Man Zero 4`) or a fuzzy match. When it isn't sure, it asks you.
- **Organize**: tidies up the folders you already have, and shows what will change before touching anything.
- **One version per game**: when the same game arrives twice, it keeps the best version (by default USA > World > Europe > Japan, originals over fan translations, clean dumps over hacks). The other goes to a `_duplicates` folder for you to review.
- **Verify**: `romkit verify` checks your files against No-Intro/Redump DATs and lists anything that is not a known good dump.
- **Audit**: `romkit audit` is a read-only report of any folder. It lists duplicates (and which copy would stay), names to fix, unverified files and stray files.
- **MAME**: arcade romset zips are stored untouched, because the emulator needs their original names.
- **Download**: searches sites you configure. It never tries to get past captchas or anti-bot pages: it stops and gives you the link instead.

## Quick start

You need [Bun](https://bun.sh) and [7-Zip](https://www.7-zip.org).

```powershell
git clone https://github.com/dartagnancoding/romkit
cd romkit
bun install
bun link                      # makes the `romkit` command available

romkit init                   # create the config
romkit systems add gba        # add a system (repeat for each console)
romkit inbox                  # organize everything in Downloads\dump
romkit import "$HOME\Downloads\game.zip" -sys gba
romkit organize -sys gba --dry-run
```

The full guide (config, naming, writing site adapters) is in [docs/GUIDE.md](docs/GUIDE.md).

## Planned

BIOS management, someday.
