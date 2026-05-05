# pi-exa-search

Web search extension for [Pi](https://pi.dev) coding agent using [Exa AI](https://exa.ai).

## Features

- **AI-synthesized answers** — Returns an AI-generated answer with source citations, not just links
- **Dual mode** — Uses Exa's direct API when `EXA_API_KEY` is set, or falls back to the free MCP endpoint (no key needed)
- **Multi-query research** — Pass `queries: [...]` with 2-4 varied angles for broader coverage
- **Full content retrieval** — Use `includeContent: true` to get full page text
- **Domain & recency filters** — Restrict results by domain or time range
- **Category filtering** — Filter by news, research papers, GitHub repos, tweets, PDFs, etc.
- **Usage tracking** — Monthly API budget tracking with warnings (1000 requests/month)
- **TUI integration** — Progress bars during searches, custom result rendering
- **Autonomous usage** — System prompt injection guides the agent to use web search when appropriate

## Installation

### As a Pi package (recommended)

```bash
pi install ./path/to/exa-search
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/.pi/agent/extensions/exa-search"]
}
```

### Manual placement

Copy this directory to `~/.pi/agent/extensions/exa-search/`. Pi auto-discovers extensions in that directory.

## Configuration

### Option 1: Environment variable

```bash
export EXA_API_KEY="your-exa-api-key"
```

### Option 2: Pi settings

Add to `~/.pi/settings.json`:

```json
{
  "env": {
    "EXA_API_KEY": "your-exa-api-key"
  }
}
```

### Option 3: Web search config

Create `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "your-exa-api-key"
}
```

> **Note:** If no API key is configured, the extension automatically uses Exa's free MCP endpoint. No setup required!

## Usage

The extension registers a `web_search` tool that the LLM can use autonomously. It also provides system prompt guidance so the agent knows when searching the web is appropriate.

### Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Single search query |
| `queries` | string[] | Multiple queries for broader research coverage |
| `numResults` | number | Results per query (default: 5, max: 20) |
| `includeContent` | boolean | Fetch full page content |
| `recencyFilter` | "day" \| "week" \| "month" \| "year" | Filter by recency |
| `domainFilter` | string[] | Include/exclude domains (prefix with `-` to exclude) |
| `type` | "auto" \| "keyword" \| "neural" | Search type |
| `category` | "news" \| "research paper" \| "github" \| "tweet" \| "movie" \| "song" \| "personal site" \| "pdf" | Result category |

### Commands

- `/exa-status` — Check configuration and usage status

## API Key vs MCP

| Feature | API Key | MCP (free) |
|---------|---------|------------|
| AI-synthesized answers | ✓ | ✗ |
| Source citations | ✓ | ✓ |
| Full content retrieval | ✓ | ✓ |
| Domain filtering | ✓ | ✓ (via query) |
| Recency filtering | ✓ | ✓ (via query) |
| Category filtering | ✓ | ✓ |
| Usage limit | 1000/month | Unlimited |
| Rate limiting | None | Fair use |

## Architecture

```
exa-search/
├── package.json          # Pi package manifest
└── src/
    ├── index.ts           # Extension entry point (tool, commands, system prompt)
    ├── exa-client.ts      # Exa API client (answer, search, MCP fallback)
    └── format.ts          # TUI rendering utilities
```

## Credits

Inspired by:
- [pi-web-agent](https://github.com/demigodmode/pi-web-agent) — DuckDuckGo search + web explore
- [pi-web-access](https://github.com/nicobailon/pi-web-access) — Multi-provider search with Exa, Perplexity, Gemini