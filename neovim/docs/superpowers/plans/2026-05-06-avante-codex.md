# Avante Codex Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Avante.nvim with the Codex ACP provider, connect it to the user's ChatGPT/Codex subscription login, add discoverable keybindings, and provide a persistent usage guide.

**Architecture:** Keep the existing lazy.nvim plugin registry in `lua/plugins/plugins.lua`. Configure Avante through its ACP provider with `npx -y @agentclientprotocol/codex-acp`, so Codex owns subscription authentication and no API key is stored in Neovim files. Put custom mappings in a focused `after/plugin/avante.lua` file and the user-facing reference in `.config/nvim/AVANTE.md`.

**Tech Stack:** Lua, Neovim, lazy.nvim, Avante.nvim, Agent Client Protocol, OpenAI Codex ACP npm adapter, Markdown.

## Global Constraints

- Use the `codex` ACP provider, not Avante's direct `openai` API-key provider.
- Do not add `OPENAI_API_KEY`, OAuth tokens, or other credentials to repository files.
- Keep automatic suggestions disabled to avoid unsolicited subscription usage.
- Preserve existing plugin and keybinding conventions; do not refactor unrelated configuration.
- Do not change Pi, tmux, zsh, or other dotfiles as part of this feature.

---

### Task 1: Add Avante and ACP dependencies

**Files:**
- Modify: `.config/nvim/lua/plugins/plugins.lua`

**Interfaces:**
- Produces a lazy.nvim plugin specification for `yetone/avante.nvim` with `provider = "codex"` and an ACP command using `npx`.

- [ ] **Step 1: Add the plugin specification after the existing Markdown/rendering plugins**

Add this Lua table as a new item in the returned plugin list:

```lua
  {
    "yetone/avante.nvim",
    event = "VeryLazy",
    version = false,
    opts = {
      mode = "agentic",
      provider = "codex",
      auto_suggestions_provider = nil,
      acp_providers = {
        codex = {
          command = "npx",
          args = { "-y", "@agentclientprotocol/codex-acp" },
        },
      },
      behaviour = {
        auto_suggestions = false,
        auto_set_highlight_group = true,
        auto_set_keymaps = true,
        auto_apply_diff_after_generation = false,
        minimize_diff = true,
        auto_approve_tool_permissions = false,
      },
      mappings = {
        submit = {
          normal = "<CR>",
          insert = "<C-g>",
        },
        cancel = {
          normal = { "<C-c>", "<Esc>", "q" },
          insert = { "<C-c>" },
        },
        sidebar = {
          apply_all = "A",
          apply_cursor = "a",
          retry_user_request = "r",
          edit_user_request = "e",
          switch_windows = "<Tab>",
          reverse_switch_windows = "<S-Tab>",
        },
        diff = {
          ours = "co",
          theirs = "ct",
          all_theirs = "ca",
          both = "cb",
          cursor = "cc",
          next = "]x",
          prev = "[x",
        },
        jump = {
          next = "]]",
          prev = "[[",
        },
        stop = "<leader>as",
      },
      windows = {
        position = "right",
        width = 36,
        wrap = true,
        sidebar_header = {
          enabled = true,
          align = "left",
          rounded = true,
        },
        input = {
          prefix = "> ",
          height = 8,
        },
      },
    },
    dependencies = {
      "nvim-lua/plenary.nvim",
      "MunifTanjim/nui.nvim",
      "stevearc/dressing.nvim",
      "nvim-treesitter/nvim-treesitter",
      "MeanderingProgrammer/render-markdown.nvim",
    },
  },
```

- [ ] **Step 2: Confirm the table is syntactically inside the returned list**

Run:

```bash
lua -e 'assert(loadfile(".config/nvim/lua/plugins/plugins.lua"))'
```

Expected: exit code `0` with no output. If the system `lua` executable is unavailable, use the headless Neovim validation in Task 4 instead.

- [ ] **Step 3: Commit the plugin specification**

```bash
git add .config/nvim/lua/plugins/plugins.lua
git commit -m "feat(nvim): add Avante Codex provider"
```

### Task 2: Add predictable custom keybindings

**Files:**
- Create: `.config/nvim/after/plugin/avante.lua`

**Interfaces:**
- Normal mode `<leader>aa` toggles Avante.
- Normal and visual mode `<leader>ac` asks Codex about the current buffer or selection.
- Normal mode `<leader>af` focuses Avante.
- Normal mode `<leader>ar` refreshes the current ACP session/provider.
- Normal mode `<leader>as` stops the active request.
- Normal mode `<leader>ah` opens `.config/nvim/AVANTE.md` through `stdpath("config")`.

- [ ] **Step 1: Create the mapping file**

```lua
local function open_avante_guide()
  vim.cmd.edit(vim.fn.stdpath("config") .. "/AVANTE.md")
end

vim.keymap.set("n", "<leader>aa", "<cmd>AvanteToggle<CR>", { desc = "Avante: toggle sidebar" })
vim.keymap.set({ "n", "v" }, "<leader>ac", "<cmd>AvanteAsk<CR>", { desc = "Avante: ask Codex" })
vim.keymap.set("n", "<leader>af", "<cmd>AvanteFocus<CR>", { desc = "Avante: focus sidebar" })
vim.keymap.set("n", "<leader>ar", "<cmd>AvanteRefresh<CR>", { desc = "Avante: refresh" })
vim.keymap.set("n", "<leader>as", "<cmd>AvanteStop<CR>", { desc = "Avante: stop request" })
vim.keymap.set("n", "<leader>ah", open_avante_guide, { desc = "Avante: open guide" })
```

- [ ] **Step 2: Check for mapping conflicts**

Run:

```bash
rg -n 'leader>aa|leader>ac|leader>af|leader>ar|leader>as|leader>ah' .config/nvim
```

Expected: only the new Avante mapping file contains these mappings.

- [ ] **Step 3: Commit the mappings**

```bash
git add .config/nvim/after/plugin/avante.lua
git commit -m "feat(nvim): add Avante keybindings"
```

### Task 3: Create the persistent Avante usage guide

**Files:**
- Create: `.config/nvim/AVANTE.md`

**Interfaces:**
- Documents Codex ACP authentication, all custom mappings, core Avante commands, diff workflow, agentic workflow, and troubleshooting.
- Is opened by `<leader>ah` and remains inside the stowed Neovim configuration.

- [ ] **Step 1: Write the guide with these exact sections**

The document must contain the following content structure:

```markdown
# Avante.nvim + OpenAI Codex

## Quick start

1. Restart Neovim or run `:Lazy sync`.
2. Press `<Space>aa` to open Avante.
3. On first use, choose the Codex/ChatGPT subscription login and finish the browser flow.
4. Press `<Space>ac` to ask about the current file. In visual mode, select code first and press `<Space>ac`.
5. Review the proposed diff before applying it.

## Keybindings

| Mapping | Mode | Action |
| --- | --- | --- |
| `<Space>aa` | Normal | Toggle Avante sidebar |
| `<Space>ac` | Normal/Visual | Ask Codex about the buffer/selection |
| `<Space>af` | Normal | Focus Avante sidebar |
| `<Space>ar` | Normal | Refresh Avante/Codex ACP session |
| `<Space>as` | Normal | Stop the active request |
| `<Space>ah` | Normal | Open this guide |
| `<CR>` | Avante normal | Submit prompt |
| `<C-g>` | Avante insert | Submit prompt |
| `<Tab>` | Avante sidebar | Switch windows |
| `A` | Avante sidebar | Apply all changes |
| `a` | Avante sidebar | Apply change at cursor |
| `r` | Avante sidebar | Retry request |
| `e` | Avante sidebar | Edit request |
| `co` / `ct` / `ca` / `cb` / `cc` | Diff | Choose ours/theirs/all theirs/both/cursor |
| `]x` / `[x` | Diff | Next/previous conflict |

## Important commands

- `:AvanteToggle`
- `:AvanteAsk`
- `:AvanteFocus`
- `:AvanteRefresh`
- `:AvanteStop`
- `:AvanteClear`
- `:AvanteSwitchProvider`
- `:AvanteModels`

## Recommended workflow

Describe the goal, include constraints, ask Codex to inspect before editing, review every diff, apply only the intended hunks, then run tests or formatters yourself.

## Authentication and security

This setup uses the Codex ACP adapter and ChatGPT/Codex subscription login. It does not use `OPENAI_API_KEY`. Never put OAuth credentials, session files, or API keys in this repository.

## Troubleshooting

- If `npx` is missing, install Node.js/npm and verify `command -v npx`.
- If the adapter cannot start, run `npx -y @agentclientprotocol/codex-acp` in a terminal to inspect its error.
- If login does not appear, run `:AvanteRefresh`, restart Neovim, and open the sidebar again.
- If a request is blocked, check the Avante permission prompt and the Codex subscription/account.
- If the first launch is slow, wait for npx to download/cache the adapter.
```

Expand the troubleshooting section with the exact error observed during validation if one occurs, without including credentials.

- [ ] **Step 2: Commit the guide**

```bash
git add .config/nvim/AVANTE.md
git commit -m "docs(nvim): add Avante Codex usage guide"
```

### Task 4: Synchronize and validate the installation

**Files:**
- Modify: `.config/nvim/lazy-lock.json` through Lazy's normal synchronization only

**Interfaces:**
- Neovim starts without Lua errors.
- Lazy recognizes Avante and its dependencies.
- The custom mappings and guide path are available.

- [ ] **Step 1: Run a headless startup check before synchronization**

```bash
XDG_CONFIG_HOME="$PWD/.config" nvim --headless '+lua require("something")' '+qa'
```

Expected: exit code `0`. If it fails, fix only the reported Avante/config issue before continuing.

- [ ] **Step 2: Synchronize lazy.nvim plugins**

```bash
XDG_CONFIG_HOME="$PWD/.config" nvim --headless "+Lazy! sync" "+qa"
```

Expected: Lazy installs Avante, `nui.nvim`, `dressing.nvim`, and any missing dependencies, then exits successfully.

- [ ] **Step 3: Validate plugin loading and mappings**

```bash
XDG_CONFIG_HOME="$PWD/.config" nvim --headless \
  '+lua local ok, avante = pcall(require, "avante"); assert(ok, avante)' \
  '+verbose nmap <Space>aa' \
  '+verbose nmap <Space>ah' \
  '+qa'
```

Expected: Avante loads and both mappings point to the intended configuration. If the plugin is event-lazy and unavailable before `VeryLazy`, trigger `:Lazy load avante.nvim` before checking.

- [ ] **Step 4: Validate the ACP executable without authenticating**

```bash
npx -y @agentclientprotocol/codex-acp --help
```

Expected: the adapter starts or prints its help/version information. Do not set or print API keys.

- [ ] **Step 5: Confirm no credentials were added**

```bash
git diff -- .config/nvim
grep -RInE 'OPENAI_API_KEY|CODEX_API_KEY|sk-[A-Za-z0-9_-]+' .config/nvim || true
```

Expected: no credential values or authentication secrets appear in the Neovim configuration.

- [ ] **Step 6: Commit the lockfile update if it contains only the intended plugin resolution**

```bash
git diff -- .config/nvim/lazy-lock.json
git add .config/nvim/lazy-lock.json
git commit -m "chore(nvim): lock Avante dependencies"
```

### Task 5: Interactive login and smoke test

**Files:**
- No additional files

**Interfaces:**
- User can start an Avante Codex session and complete subscription authentication interactively.

- [ ] **Step 1: Restart Neovim and open Avante**

Press `<Space>aa`. When the Codex ACP authentication prompt appears, choose ChatGPT/Codex subscription login and complete the browser flow.

- [ ] **Step 2: Send a read-only question**

Use `<Space>ac` and ask: `Explain what this file does. Do not edit anything.` Confirm that a response returns through the Codex subscription.

- [ ] **Step 3: Test visual context**

Select a small code block in visual mode, press `<Space>ac`, and ask: `Review this selection for bugs. Do not modify it.` Confirm that the selected context is included.

- [ ] **Step 4: Test a controlled diff**

Ask Avante for a small, explicit change, inspect the generated diff, and apply only the intended hunk with the sidebar `a` mapping. Run the project's available validation afterward.

- [ ] **Step 5: Record only non-secret troubleshooting notes**

If the smoke test fails, record the command/error text in `.config/nvim/AVANTE.md` without recording browser URLs, tokens, cookies, or API keys.
