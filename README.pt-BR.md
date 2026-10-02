# romkit

*[Read in English](README.md)*

Algo que eu criei pra me ajudar a organizar e aumentar minha biblioteca de jogos retrô.

O `romkit` é uma ferramenta de linha de comando (TypeScript + Bun, feita para o PowerShell no
Windows). Ela baixa ROMs, extrai, dá nomes limpos e guarda cada uma na pasta do seu sistema:

```
E:\ROM\
  Game Boy Advance\Mega Man Zero 4.gba
  PlayStation\Crash Bandicoot.cue
  PlayStation\Crash Bandicoot.bin
  MAME\pacman.zip
```

## O que ele faz

- **Download**: busca nos sites que você configurar e deixa você escolher o resultado.
- **Import**: processa arquivos que você baixou por conta própria.
- **Arquivos compactados**: extrai zip, rar e 7z, fica só com o jogo e descarta readmes e `.nfo`.
- **Nomes**: acha o nome certo pelos DATs do No-Intro/Redump, por uma lista de apelidos (`MMZ4` → `Mega Man Zero 4`) ou por comparação aproximada. Quando não tem certeza, pergunta.
- **Organizar**: arruma as pastas que você já tem, mostrando antes o que vai mudar.

Ele nunca tenta passar por captchas ou proteções anti-bot. Para e te mostra o link.

## Começo rápido

Precisa do [Bun](https://bun.sh) e do [7-Zip](https://www.7-zip.org).

```powershell
git clone https://github.com/dartagnancoding/romkit
cd romkit
bun install
bun link                      # deixa o comando `romkit` disponível

romkit init                   # cria a configuração
romkit systems add gba        # adiciona um sistema
romkit download mega man zero 4 -sys gba
romkit import "$HOME\Downloads\jogo.zip" -sys gba
romkit organize -sys gba --dry-run
```

O guia completo (configuração, nomeação, como escrever adaptadores de sites) está em
[docs/GUIDE.md](docs/GUIDE.md) (em inglês).

## Planos

Gerenciar BIOS, algum dia.
