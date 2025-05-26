-- Updated lsp.lua with better Python and Svelte support
local lsp = require("lsp-zero")

lsp.preset("recommended")

-- Mason setup for package management
require('mason').setup({})
require('mason-lspconfig').setup({
  ensure_installed = {
    'pyright', 'ruff', 'lua_ls', 'svelte', 'tailwindcss',
    'gopls', 'templ', 'jsonls', 'eslint', 'tsserver'
  },
})

-- Configure EFM for general formatting support
require('lspconfig').efm.setup {
  root_dir = require('lspconfig/util').root_pattern(".git", "pnpm-workspace.yml"),
}

-- Setup specific LSP handlers
require("mason-lspconfig").setup_handlers {
  -- Default handler for servers without specific configuration
  function(server_name)
    require("lspconfig")[server_name].setup {}
  end,

  -- Python-specific LSP setups
  ["pyright"] = function()
    require("lspconfig").pyright.setup {
      settings = {
        pyright = {
          -- Keep organize imports disabled as Ruff will handle this
          disableOrganizeImports = true,
        },
        python = {
          analysis = {
            -- Enable type checking
            typeCheckingMode = "basic", -- Can be "off", "basic", or "strict"
            autoSearchPaths = true,
            useLibraryCodeForTypes = true,
            diagnosticMode = "workspace",
          },
        },
      }
    }
  end,

  ["ruff"] = function()
    require("lspconfig").ruff.setup {
      -- Enable Ruff to provide hover information for diagnostics
      on_attach = function(client, bufnr)
        -- Enable hover now so you get useful information
        client.server_capabilities.hoverProvider = true

        -- Add specific keybinding for formatting with Ruff
        vim.keymap.set("n", "<leader>rf", function()
          vim.cmd("RuffFormat")
        end, { buffer = bufnr, desc = "Format with Ruff" })
      end,

      settings = {
        -- Configure Ruff settings
        ruff = {
          format = {
            -- Automatically format on save
            enabled = true,
          },
          lint = {
            -- Enable all recommended rules by default
            run = "onSave",
            -- You can select specific rule sets to enable/disable
            -- Select rules that cover flake8, isort, pyupgrade, etc.
            -- See https://beta.ruff.rs/docs/rules/
            select = {
              "E", "F", "I", "W", "UP", "N", "B", "A", "C4", "PT", "RET", "SIM"
            },
            -- Rules to explicitly ignore
            ignore = {},
          },
          -- Line length matches your colorcolumn setting
          lineLenght = 80,
        }
      }
    }
  end,

  -- Enhanced Svelte Configuration
  ["svelte"] = function()
    require("lspconfig").svelte.setup {
      on_attach = function(client, bufnr)
        -- Keep existing JS/TS file change notification
        vim.api.nvim_create_autocmd("BufWritePost", {
          pattern = { "*.js", "*.ts" },
          callback = function(ctx)
            client.notify("$/onDidChangeTsOrJsFile", { uri = ctx.file })
          end,
        })

        -- Enhance completions for HTML parts
        client.server_capabilities.completionProvider = {
          triggerCharacters = {
            ".", ":", "<", "\"", "'", "/", "@", "*",
            "#", "$", "+", "^", "(", "[", "-", "_"
          }
        }

        -- Optional: Add keybinding for manually triggering completion
        vim.keymap.set("i", "<C-Space>", function()
          vim.lsp.buf.completion()
        end, { buffer = bufnr, noremap = true, silent = true })
      end,
      settings = {
        svelte = {
          plugin = {
            html = { completions = { enable = true, emmet = true } },
            svelte = { completions = { enable = true } },
            css = { completions = { enable = true, emmet = true } }
          }
        }
      }
    }
  end,

  -- Keep your other server configurations
  ["tailwindcss"] = function()
    require("lspconfig").tailwindcss.setup {
      root_dir = require("lspconfig").util.root_pattern("tailwind.config.js"),
      lint = {
        unknownAtRules = "ignore",
      },
    }
  end,
}

-- Format on save setup
local augroup = vim.api.nvim_create_augroup('LspFormatting', {})
local lsp_format_on_save = function(bufnr)
  vim.api.nvim_clear_autocmds({ group = augroup, buffer = bufnr })
  vim.api.nvim_create_autocmd('BufWritePre', {
    group = augroup,
    buffer = bufnr,
    callback = function()
      -- Format the current buffer using the attached LSP
      vim.lsp.buf.format({
        -- Filter formatting to only use certain servers
        filter = function(client)
          -- For Python files, prefer Ruff for formatting
          if vim.bo.filetype == "python" then
            return client.name == "ruff"
          end
          -- For other files, use any formatter
          return true
        end,
        bufnr = bufnr,
      })
    end,
  })
end

-- Setup autocompletion
local cmp = require('cmp')
local cmp_action = require('lsp-zero').cmp_action()
local cmp_select = { behavior = cmp.SelectBehavior.Select }

-- Consolidated CMP setup (fixing the issue of two separate setups)
cmp.setup({
  window = {
    completion = cmp.config.window.bordered(),
    documentation = cmp.config.window.bordered()
  },
  sources = {
    { name = 'nvim_lsp' },
    { name = 'luasnip' }, -- Add snippet support (if you have luasnip installed)
    { name = 'buffer' },  -- Add buffer source for more completions
    { name = 'path' }     -- Add path source for file path completions
  },
  mapping = cmp.mapping.preset.insert({
    ['<C-p>'] = cmp.mapping.select_prev_item(cmp_select),
    ['<C-n>'] = cmp.mapping.select_next_item(cmp_select),
    ['<C-y>'] = cmp.mapping.confirm({ select = true }),
    ["<C-Space>"] = cmp.mapping.complete(),
  })
})

lsp.set_preferences({
  suggest_lsp_servers = false,
  sign_icons = {
    error = 'E',
    warn = 'W',
    hint = 'H',
    info = 'I'
  }
})

lsp.on_attach(function(client, bufnr)
  local opts = { buffer = bufnr, remap = false }

  -- Enable document formatting if the client supports it
  client.server_capabilities.documentFormattingProvider = true

  -- Setup format on save
  lsp_format_on_save(bufnr)

  -- LSP keybindings
  vim.keymap.set("n", "gd", function() vim.lsp.buf.definition() end, opts)
  vim.keymap.set("n", "gD", function() vim.lsp.buf.declaration() end, opts)
  vim.keymap.set("n", "gt", function() vim.lsp.buf.type_definition() end, opts)
  vim.keymap.set("n", "gi", function() vim.lsp.buf.implementation() end, opts)
  vim.keymap.set("n", "K", function() vim.lsp.buf.hover() end, opts)
  vim.keymap.set("n", "<leader>vws", function() vim.lsp.buf.workspace_symbol() end, opts)
  vim.keymap.set("n", "<leader>vd", function() vim.diagnostic.open_float() end, opts)
  vim.keymap.set("n", "[d", function() vim.diagnostic.goto_next() end, opts)
  vim.keymap.set("n", "]d", function() vim.diagnostic.goto_prev() end, opts)
  vim.keymap.set("n", "<leader>vca", function() vim.lsp.buf.code_action() end, opts)
  vim.keymap.set("n", "<leader>vrr", function() vim.lsp.buf.references() end, opts)
  vim.keymap.set("n", "<leader>vrn", function() vim.lsp.buf.rename() end, opts)
  vim.keymap.set("i", "<C-h>", function() vim.lsp.buf.signature_help() end, opts)
end)

lsp.setup()

-- Configure diagnostics display
vim.diagnostic.config({
  virtual_text = true,
  signs = true,
  underline = true,
  update_in_insert = false,
  severity_sort = true,
})
