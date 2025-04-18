-- Place this in: .config/nvim/after/plugin/codecompanion.lua

require("codecompanion").setup({
  strategies = {
    chat = {
      adapter = "copilot",
    },
    inline = {
      adapter = "copilot",
    },
    agent = {
      adapter = "copilot",
    },
  },

  display = {
    action_palette = {
      width = 95,
      height = 10,
      prompt = "Prompt ",                   -- Prompt used for interactive LLM calls
      provider = "telescope",               -- default|telescope|mini_pick
      opts = {
        show_default_actions = true,        -- Show the default actions in the action palette?
        show_default_prompt_library = true, -- Show the default prompt library in the action palette?
      },
    },
  },

  -- UI configuration
  ui = {
    -- Set to "popup" for a popup window or "split" for a split
    mode = "split",
    -- "right", "left", "top", "bottom"
    position = "right",
    -- Width or height based on position (for split mode)
    size = {
      width = "30%",
      height = "40%",
    },
    -- Auto-close the UI when losing focus
    close_on_leave = false,
    -- Border style (for popup mode)
    border = "rounded",
  },

  -- Auto-insert settings
  auto_insert = {
    enable = true,
    matching = true, -- Contextual suggestions
    trigger_on_keystroke = true,
    debounce_ms = 100,
    accept_key = "<C-g>",
    next_suggestion = "<C-n>",
    prev_suggestion = "<C-p>",
    dismiss_key = "<C-]>",
  },

  -- Chat settings for conversational features
  chat = {
    welcome_message = "How can I help you with your code today?",
    keymaps = {
      send = "<CR>",
      discard = "<C-c>",
      stop = "<C-x>",
    },
    -- Context to include in chat
    include_context = true,
    -- Include project files' information in prompt
    include_project_context = false,
  },

  -- Contextual commands for specific tasks
  commands = {
    -- Add custom commands as needed
    -- For example:
    -- explain_code = "Explain what this code does in detail:"
  },

  -- Additional settings
  debug = false, -- Set to true to enable debug logging
})

-- Define useful keymaps for codecompanion
vim.keymap.set("n", "<leader>ccc", ":CodeCompanionChat<CR>", { desc = "Open Code Companion Chat" })
vim.keymap.set("n", "<leader>ct", ":CodeCompanionToggle<CR>", { desc = "Toggle Code Companion" })
vim.keymap.set("v", "<leader>ccl", ":CodeCompanion<CR>", { desc = "Refactor selected code" })
-- vim.keymap.set("v", "<leader>ce", ":CodeCompanionExplain<CR>", { desc = "Explain selected code" })
-- vim.keymap.set("v", "<leader>cd", ":CodeCompanionDocs<CR>", { desc = "Generate docs for selection" })
