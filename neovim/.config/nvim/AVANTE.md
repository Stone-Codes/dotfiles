# Avante.nvim + OpenAI Codex

Avante is an AI coding sidebar for Neovim. This configuration connects it to the **OpenAI Codex ACP adapter**, using your ChatGPT/Codex subscription login rather than an OpenAI API key.

## Quick start

1. Restart Neovim, or run `:Lazy sync`.
2. Press `<Space>aa` to open the Avante sidebar.
3. On first use, choose the Codex/ChatGPT subscription login and complete the browser flow.
4. Press `<Space>ac` to ask about the current file.
5. In visual mode, select code and press `<Space>ac` to ask about only that selection.
6. Review every proposed diff before applying it.

The leader key is `<Space>` in this configuration.

## Keybindings

### Global Avante mappings

| Mapping | Mode | Action |
| --- | --- | --- |
| `<Space>aa` | Normal | Toggle Avante sidebar |
| `<Space>ac` | Normal/Visual | Ask Codex about the buffer or selection |
| `<Space>af` | Normal | Focus the Avante sidebar |
| `<Space>ar` | Normal | Refresh Avante/Codex ACP session |
| `<Space>as` | Normal | Stop the active request |
| `<Space>ah` | Normal | Open this guide |

### Avante sidebar mappings

| Mapping | Action |
| --- | --- |
| `<CR>` | Submit prompt in normal mode |
| `<C-g>` | Submit prompt in insert mode |
| `<C-c>` / `<Esc>` / `q` | Cancel the current input/request |
| `<Tab>` | Switch between sidebar windows |
| `<S-Tab>` | Switch windows in reverse |
| `A` | Apply all generated changes |
| `a` | Apply the change at the cursor |
| `r` | Retry the request |
| `e` | Edit the request |

### Diff mappings

| Mapping | Action |
| --- | --- |
| `co` | Keep our version |
| `ct` | Keep the generated version |
| `ca` | Keep all generated changes |
| `cb` | Keep both versions |
| `cc` | Keep the version at the cursor |
| `]x` / `[x` | Next/previous diff conflict |
| `]]` / `[[` | Next/previous jump location |

## Important commands

- `:AvanteToggle` — toggle the sidebar
- `:AvanteAsk` — ask about the current buffer or visual selection
- `:AvanteFocus` — focus the sidebar
- `:AvanteRefresh` — refresh the provider/session
- `:AvanteStop` — stop the active request
- `:AvanteClear` — clear the current conversation
- `:AvanteSwitchProvider` — switch providers
- `:AvanteModels` — choose an available model when supported
- `:Lazy` — inspect or manage installed plugins
- `:Lazy sync` — install/update plugins from the lockfile

## Recommended workflow

### Ask questions safely

Be explicit about whether Codex may edit files:

```text
Explain this file. Do not edit anything.
```

For a review:

```text
Review this selection for bugs and edge cases. Do not modify it.
```

### Make a controlled change

1. Explain the desired result and constraints.
2. Ask Codex to inspect the relevant files first.
3. Request a small, focused change.
4. Review the generated diff in the sidebar.
5. Apply only the intended hunk with `a`, or all intended changes with `A`.
6. Run tests, formatting, and type checks yourself.
7. Ask Codex to review the final diff if needed.

### Include files as context

Use Avante's file/context controls in the sidebar to add related files. Keep context focused: include the implementation, its tests, and the relevant configuration rather than the entire repository.

## Authentication and security

This setup uses:

```text
Avante → Codex ACP → OpenAI Codex → ChatGPT/Codex subscription login
```

It does **not** use `OPENAI_API_KEY` and does not store credentials in this repository. Never commit:

- API keys
- OAuth access or refresh tokens
- Browser cookies
- Codex session/auth files
- Copied login URLs containing sensitive parameters

The ACP adapter is launched with:

```text
npx -y @agentclientprotocol/codex-acp
```

The first launch may take longer while `npx` downloads and caches the adapter.

## Troubleshooting

### Avante does not open

1. Run `:Lazy` and check that `avante.nvim` is installed.
2. Run `:Lazy sync`.
3. Restart Neovim.
4. Try `:AvanteToggle` directly.
5. Check `:messages` for Lua/plugin errors.

### Login does not appear

Run `:AvanteRefresh`, restart Neovim, and open the sidebar again. Complete the browser flow offered by Codex ACP.

### ACP adapter cannot start

Check that Node and npx are available:

```bash
command -v node
command -v npx
npx -y @agentclientprotocol/codex-acp --help
```

If `npx` is missing, install Node.js/npm and restart Neovim so the updated PATH is available.

### The first request is slow

This is expected on the first adapter launch because `npx` may download and cache `@agentclientprotocol/codex-acp`.

### A request is blocked

Avante is configured not to auto-approve tool permissions. Read the permission prompt and approve only actions you understand. Stop the request with `<Space>as` or `:AvanteStop` if it begins doing something unexpected.

### The subscription is unavailable

Confirm that the Codex/ChatGPT account is the account you intended to use and that the subscription is active. This integration is separate from Avante's direct API-key OpenAI provider.

## Configuration location

- Plugin setup: `.config/nvim/lua/plugins/plugins.lua`
- Custom keybindings: `.config/nvim/after/plugin/avante.lua`
- This guide: `.config/nvim/AVANTE.md`
- Lazy lockfile: `.config/nvim/lazy-lock.json`
