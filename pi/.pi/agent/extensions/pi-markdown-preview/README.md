# pi-markdown-preview

A minimal, secure markdown preview extension for [pi](https://pi.dev).

Renders assistant responses and local markdown files as inline images in the terminal (via Kitty/iTerm2/Ghostty/WezTerm image protocols) or opens them in your default browser.

## Install

```bash
# From this directory
pi install git:github.com/YOURNAME/pi-markdown-preview

# Or copy directly to your pi extensions folder
cp -r . ~/.pi/agent/extensions/pi-markdown-preview
```

Then run `pi` and use `/preview`.

## Prerequisites

- [Pandoc](https://pandoc.org/installing.html) — `brew install pandoc` (macOS) or `apt install pandoc` (Linux)
- A Chromium-based browser (Chrome, Brave, Edge, Chromium) — used headlessly for rendering
  - Set `PUPPETEER_EXECUTABLE_PATH` if pi can't find your browser automatically

## Usage

| Command | Description |
|---------|-------------|
| `/preview` | Preview the last assistant response in terminal |
| `/preview <file.md>` | Preview a markdown or code file |
| `/preview --browser` | Open the last assistant response in your default browser |
| `/preview <file.md> --browser` | Open a file preview in browser |
| `/preview-clear-cache` | Clear the render cache |

### Terminal Preview Shortcuts

When viewing a preview in the terminal:

| Key | Action |
|-----|--------|
| `←` / `→` | Navigate pages (if content is long) |
| `r` | Refresh with current theme |
| `o` | Open current preview in browser |
| `Esc` / `Ctrl+C` | Close preview |

## Configuration

| Environment Variable | Description |
|---------------------|-------------|
| `PANDOC_PATH` | Path to pandoc binary if not on `$PATH` |
| `PUPPETEER_EXECUTABLE_PATH` | Path to Chrome/Edge/Chromium binary |
| `PUPPETEER_NO_SANDBOX` | Set to `1` on Linux only if you hit sandbox errors (less secure) |

## Security Improvements Over Original

This reproduction addresses several security concerns found in the upstream package:

1. **Sandbox preserved by default** — `--no-sandbox` is only applied on Linux if `PUPPETEER_NO_SANDBOX=1` is explicitly set.
2. **Path traversal protection** — File preview resolves paths strictly within the current working directory.
3. **No LaTeX shell escape** — LaTeX/PDF support is omitted entirely, removing the `\write18` attack surface.
4. **Safe symlink handling** — No symlink creation in temp directories (removed the `compileLatexToPdf` symlink vector).

## License

MIT
