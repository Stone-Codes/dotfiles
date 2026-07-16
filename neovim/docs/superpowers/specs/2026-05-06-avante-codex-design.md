# Avante with OpenAI Codex Subscription

## Goal

Install Avante.nvim in the existing lazy.nvim-based Neovim configuration and connect it to the user's OpenAI Codex subscription through Codex ACP authentication, without adding an OpenAI API key to the dotfiles. Provide a durable Markdown reference for setup, authentication, commands, keybindings, workflows, and troubleshooting.

## Decision

Use Avante's ACP provider integration with the official Codex ACP adapter:

- Avante provider: `codex`
- Adapter command: `npx -y @agentclientprotocol/codex-acp`
- Authentication: Codex's normal ChatGPT subscription login flow
- No `OPENAI_API_KEY` or other secret stored in the repository

The direct Avante OpenAI provider is explicitly not used because it requires API-key authentication and API billing rather than the user's Codex subscription.

## Configuration

Add Avante to `.config/nvim/lua/plugins/plugins.lua` with its required dependencies and configure it in agentic mode. Configure the `codex` ACP provider to run through `npx`, allowing the adapter to use the local Codex authentication/session state. Keep automatic suggestions disabled to avoid unexpected subscription usage.

Add plugin-specific mappings in `.config/nvim/after/plugin/avante.lua`, following the repository's existing plugin mapping convention. Use a consistent `<leader>a` prefix for opening/toggling Avante, asking questions, refreshing, stopping, and opening the reference document. Preserve Avante's built-in buffer-local mappings for submitting prompts and applying diffs unless a conflict requires an explicit override.

## User documentation

Create `.config/nvim/AVANTE.md` as the persistent reference. It will contain:

- What Avante is and how the Codex ACP connection works
- First-login instructions and prerequisites
- Normal, visual-selection, and agentic workflows
- All custom keybindings and important Avante commands
- Diff review/apply/reject guidance
- Model/provider notes
- Troubleshooting for missing `npx`, authentication, adapter startup, network, and permission errors
- Security notes stating that API keys must not be committed

The Neovim mapping for the document should open it using the existing editor command path, so it remains accessible without remembering a filesystem path.

## Validation

After implementation:

1. Validate Lua files with a headless Neovim startup check.
2. Run Lazy's synchronization/install operation and confirm Avante appears in the plugin state/lockfile.
3. Confirm the configured ACP command is available through `npx` without placing credentials in config files.
4. Verify the custom mappings are registered and the documentation opens from Neovim.
5. Test the login/startup path as far as possible without exposing credentials; the user completes the browser login interactively.

## Scope boundaries

This setup does not install a separate global Codex binary unless the ACP adapter requires it, does not create or store API keys, and does not change unrelated tmux, zsh, or Pi configuration. Investigation of recurring Pi review prompts is a separate follow-up task after the Avante setup is complete.
