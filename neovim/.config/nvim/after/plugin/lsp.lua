-- Neovim 0.11+ and mason-lspconfig v2 use vim.lsp.config directly.
local lsp = require("lsp-zero")
local cmp = require("cmp")

vim.lsp.config("*", {
  capabilities = require("cmp_nvim_lsp").default_capabilities(),
})

vim.lsp.config("pyright", {
  settings = {
    pyright = { disableOrganizeImports = true },
    python = {
      analysis = {
        typeCheckingMode = "basic",
        autoSearchPaths = true,
        useLibraryCodeForTypes = true,
        diagnosticMode = "workspace",
      },
    },
  },
})

vim.lsp.config("ruff", {
  init_options = {
    settings = {
      lineLength = 80,
      lint = {
        select = { "E", "F", "I", "W", "UP", "N", "B", "A", "C4", "PT", "RET", "SIM" },
        ignore = {},
      },
    },
  },
  on_attach = function(client, bufnr)
    -- Pyright provides Python hover; Ruff handles linting and formatting.
    client.server_capabilities.hoverProvider = false
    vim.keymap.set("n", "<leader>rf", function()
      vim.lsp.buf.format({ bufnr = bufnr, name = "ruff", timeout_ms = 2000 })
    end, { buffer = bufnr, desc = "Format with Ruff" })
  end,
})

vim.lsp.config("svelte", {
  settings = {
    svelte = {
      plugin = {
        html = { completions = { enable = true, emmet = true } },
        svelte = { completions = { enable = true } },
        css = { completions = { enable = true, emmet = true } },
      },
    },
  },
})
-- Keep nvim-lspconfig's Svelte change notifications and Tailwind root detection.

-- Use the same formatter selection for manual formatting and format on save.
local function format_buffer(bufnr)
  local function use_formatter(client)
    return vim.bo[bufnr].filetype ~= "python" or client.name == "ruff"
  end
  local clients = vim.lsp.get_clients({ bufnr = bufnr, method = "textDocument/formatting" })
  if not vim.iter(clients):any(use_formatter) then
    return
  end
  vim.lsp.buf.format({ bufnr = bufnr, filter = use_formatter, timeout_ms = 2000 })
end

vim.keymap.set("n", "<leader>f", function()
  format_buffer(vim.api.nvim_get_current_buf())
end, { desc = "Format buffer" })

local formatting_group = vim.api.nvim_create_augroup("LspFormatting", { clear = true })
local function format_on_save(bufnr)
  vim.api.nvim_clear_autocmds({ group = formatting_group, buffer = bufnr })
  vim.api.nvim_create_autocmd("BufWritePre", {
    group = formatting_group,
    buffer = bufnr,
    callback = function() format_buffer(bufnr) end,
  })
end

local cmp_select = { behavior = cmp.SelectBehavior.Select }
cmp.setup({
  snippet = {
    expand = function(args) require("luasnip").lsp_expand(args.body) end,
  },
  window = {
    completion = cmp.config.window.bordered(),
    documentation = cmp.config.window.bordered(),
  },
  sources = {
    { name = "nvim_lsp" },
    { name = "luasnip" },
    { name = "buffer" },
    { name = "path" },
  },
  mapping = cmp.mapping.preset.insert({
    ["<C-p>"] = cmp.mapping.select_prev_item(cmp_select),
    ["<C-n>"] = cmp.mapping.select_next_item(cmp_select),
    ["<C-y>"] = cmp.mapping.confirm({ select = true }),
    ["<C-Space>"] = cmp.mapping.complete(),
  }),
})

lsp.on_attach(function(_, bufnr)
  local opts = { buffer = bufnr, remap = false }
  format_on_save(bufnr)

  vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)
  vim.keymap.set("n", "gD", vim.lsp.buf.declaration, opts)
  vim.keymap.set("n", "gt", vim.lsp.buf.type_definition, opts)
  vim.keymap.set("n", "gi", vim.lsp.buf.implementation, opts)
  vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
  vim.keymap.set("n", "<leader>vws", vim.lsp.buf.workspace_symbol, opts)
  vim.keymap.set("n", "<leader>vd", vim.diagnostic.open_float, opts)
  vim.keymap.set("n", "L", function()
    vim.diagnostic.open_float(nil, {
      border = "rounded",
      source = "always",
      prefix = " ",
      scope = "cursor",
    })
  end, opts)
  vim.keymap.set("n", "[d", function() vim.diagnostic.jump({ count = -1 }) end, opts)
  vim.keymap.set("n", "]d", function() vim.diagnostic.jump({ count = 1 }) end, opts)
  vim.keymap.set("n", "<leader>vca", vim.lsp.buf.code_action, opts)
  vim.keymap.set("n", "<leader>vrr", vim.lsp.buf.references, opts)
  vim.keymap.set("n", "<leader>vrn", vim.lsp.buf.rename, opts)
  vim.keymap.set("i", "<C-h>", vim.lsp.buf.signature_help, opts)
end)

-- Enable installed servers only after their settings and attach hooks are ready.
require("mason").setup({})
require("mason-lspconfig").setup({
  ensure_installed = {
    "pyright", "ruff", "lua_ls", "svelte", "tailwindcss",
    "gopls", "templ", "jsonls", "eslint", "ts_ls",
  },
})

vim.diagnostic.config({
  virtual_text = { prefix = "●", spacing = 4 },
  signs = {
    text = {
      [vim.diagnostic.severity.ERROR] = "✘",
      [vim.diagnostic.severity.WARN] = "▲",
      [vim.diagnostic.severity.HINT] = "⚑",
      [vim.diagnostic.severity.INFO] = "»",
    },
    numhl = {
      [vim.diagnostic.severity.ERROR] = "DiagnosticSignError",
      [vim.diagnostic.severity.WARN] = "DiagnosticSignWarn",
      [vim.diagnostic.severity.HINT] = "DiagnosticSignHint",
      [vim.diagnostic.severity.INFO] = "DiagnosticSignInfo",
    },
  },
  underline = true,
  update_in_insert = false,
  severity_sort = true,
  float = {
    border = "rounded",
    source = "always",
    header = "",
    prefix = "",
    focusable = false,
  },
})

-- Configure diagnostic highlight colors
vim.api.nvim_set_hl(0, 'DiagnosticError', { fg = '#db4b4b', bold = true })
vim.api.nvim_set_hl(0, 'DiagnosticWarn', { fg = '#e0af68', bold = true })
vim.api.nvim_set_hl(0, 'DiagnosticInfo', { fg = '#0db9d7', bold = true })
vim.api.nvim_set_hl(0, 'DiagnosticHint', { fg = '#1abc9c', bold = true })

vim.api.nvim_set_hl(0, 'DiagnosticVirtualTextError', { fg = '#db4b4b', italic = true })
vim.api.nvim_set_hl(0, 'DiagnosticVirtualTextWarn', { fg = '#e0af68', italic = true })
vim.api.nvim_set_hl(0, 'DiagnosticVirtualTextInfo', { fg = '#0db9d7', italic = true })
vim.api.nvim_set_hl(0, 'DiagnosticVirtualTextHint', { fg = '#1abc9c', italic = true })

vim.api.nvim_set_hl(0, 'DiagnosticUnderlineError', { undercurl = true, sp = '#db4b4b' })
vim.api.nvim_set_hl(0, 'DiagnosticUnderlineWarn', { undercurl = true, sp = '#e0af68' })
vim.api.nvim_set_hl(0, 'DiagnosticUnderlineInfo', { undercurl = true, sp = '#0db9d7' })
vim.api.nvim_set_hl(0, 'DiagnosticUnderlineHint', { undercurl = true, sp = '#1abc9c' })
