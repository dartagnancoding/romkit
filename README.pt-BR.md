# romkit

*[Read in English](README.md)*

Algo que eu criei pra me ajudar a organizar e aumentar minha biblioteca de jogos retrô.

O `romkit` é uma ferramenta de linha de comando (TypeScript + Bun, feita para o PowerShell no
Windows). Você joga os jogos que dumpou numa pasta, e ele descobre de qual console é cada um, extrai,
dá um nome limpo e guarda na pasta certa:

```
E:\ROM\
  Game Boy Advance\Mega Man Zero 4.gba
  PlayStation\Crash Bandicoot.cue
  PlayStation\Crash Bandicoot.bin
  MAME\pacman.zip
```

## O jeito mais fácil: a pasta de entrada

1. Coloque os arquivos em `Downloads\dump`. Pode ser zip, rar, 7z, ISO, cue/bin, RAR dividido em partes...
2. Dê dois cliques em `Organizar dump.bat`.
3. O romkit mostra para onde vai cada arquivo e pergunta antes de mover.

Ele descobre o console:

- **pelo nome da subpasta**, se houver (`dump\snes\...`);
- **pela extensão** (`.gba`, `.sfc`...);
- **pelo cabeçalho do arquivo, quando a extensão não basta.** Um `.iso` pode ser GameCube, Wii ou PS2, e o cabeçalho diz qual. Isso funciona até dentro de zip, sem extrair tudo.

Um `.bin` de PS1 sem `.cue` ganha um `.cue` gerado automaticamente.

O `.bat` está em [`scripts/`](scripts/Organizar%20dump.bat). Copie para onde quiser.

## O que mais ele faz

- **Nomes**: acha o nome certo pelos DATs do No-Intro/Redump, por uma lista de apelidos (`MMZ4` → `Mega Man Zero 4`) ou por comparação aproximada. Quando não tem certeza, pergunta.
- **Organizar**: arruma as pastas que você já tem, mostrando antes o que vai mudar.
- **Uma versão por jogo**: quando o mesmo jogo chega duas vezes, ele fica com a melhor versão (por padrão USA > World > Europe > Japan, original antes de tradução, dump limpo antes de hack). A outra vai para uma pasta `_duplicates` para você revisar.
- **Verificar**: `romkit verify` confere seus arquivos contra os DATs do No-Intro/Redump e lista o que não for um dump bom conhecido.
- **Auditar**: `romkit audit` gera um relatório, só de leitura, de qualquer pasta. Ele lista duplicatas (e qual cópia ficaria), nomes a corrigir, arquivos não verificados e arquivos avulsos.
- **MAME**: os zips de arcade são guardados intactos, porque o emulador precisa do nome original.
- **Download**: busca em sites que você configurar, inclusive listas simples de arquivos. Arquivos grandes continuam de onde pararam se a conexão cair ou você apertar Ctrl+C, e ficam mais rápidos com o [aria2c](https://aria2.github.io/) instalado. Ele nunca tenta passar por captchas ou proteções anti-bot: para e te mostra o link.
- **Levar a configuração para outro PC**: `romkit sources export` / `import` leva suas fontes (e os sistemas que elas usam) para outro computador.

## Instalar

Cole isto no PowerShell (não precisa de administrador). Ele instala o `romkit.exe` da versão mais
recente e coloca no PATH. Para atualizar, é só rodar de novo.

```powershell
irm https://raw.githubusercontent.com/dartagnancoding/romkit/main/install.ps1 | iex
romkit init      # pergunta as pastas, instala 7-Zip/aria2c se você quiser, importa fontes
```

## Começo rápido (pelo código-fonte)

Precisa do [Bun](https://bun.sh) e do [7-Zip](https://www.7-zip.org).

```powershell
git clone https://github.com/dartagnancoding/romkit
cd romkit
bun install
bun link                      # deixa o comando `romkit` disponível

romkit init                   # cria a configuração (pastas, 7-Zip, aria2c, fontes)
romkit config                 # vê e muda as configurações depois
romkit systems add gba        # adiciona um sistema (repita para cada console)
romkit inbox                  # organiza tudo que estiver em Downloads\dump
romkit import "$HOME\Downloads\jogo.zip" -sys gba
romkit organize -sys gba --dry-run
```

O guia completo (configuração, nomeação, adaptadores de sites) está em
[docs/GUIDE.md](docs/GUIDE.md) (em inglês).

## Planos

Gerenciar BIOS, algum dia.
