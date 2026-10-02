# romkit

*[Leia em português](README.pt-BR.md)*

Something I built to help me organize, and grow, my retro game library.

`romkit` is a small command-line tool (TypeScript + Bun, made for PowerShell on Windows). It
downloads ROMs, extracts them, gives them clean names and puts each one in its system's folder:

```
E:\ROM\
  Game Boy Advance\Mega Man Zero 4.gba
  PlayStation\Crash Bandicoot.cue
  PlayStation\Crash Bandicoot.bin
  MAME\pacman.zip
```

## What it does

- **Download**: searches the sites you configure and lets you pick a result.
- **Import**: handles files you downloaded yourself.
- **Archives**: extracts zip, rar and 7z, keeps the game and throws away readmes and `.nfo` files.
- **Names**: finds the right name using No-Intro/Redump DATs, a nickname list (`MMZ4` → `Mega Man Zero 4`) or a fuzzy match. When it isn't sure, it asks you.
- **Organize**: tidies up the folders you already have, and shows what will change before touching anything.

It never tries to get past captchas or anti-bot pages. It stops and gives you the link instead.

## Quick start

You need [Bun](https://bun.sh) and [7-Zip](https://www.7-zip.org).

```powershell
git clone https://github.com/dartagnancoding/romkit
cd romkit
bun install
bun link                      # makes the `romkit` command available

romkit init                   # create the config
romkit systems add gba        # add a system
romkit download mega man zero 4 -sys gba
romkit import "$HOME\Downloads\game.zip" -sys gba
romkit organize -sys gba --dry-run
```

The full guide (config, naming, writing site adapters) is in [docs/GUIDE.md](docs/GUIDE.md).

## Planned

BIOS management, someday.
