local lsp = require("lsp-zero")

lsp.preset("recommended")

require('lspconfig').efm.setup {
  root_dir = require('lspconfig/util').root_pattern(".git", "pnpm-workspace.yml"),
}

require('mason').setup({})
require('mason-lspconfig').setup({
  -- Replace the language servers listed here
  -- with the ones you want to install
  ensure_installed = { 'efm', 'lua_ls', 'svelte', 'tailwindcss', 'gopls', 'templ', 'pyright', 'jsonls', 'ruff' },
  -- handlers = {
  --   lsp.default_setup,
  -- },
})

require("mason-lspconfig").setup_handlers {
  -- The first entry (without a key) will be the default handler
  -- and will be called for each installed server that doesn't have
  -- a dedicated handler.
  function(server_name) -- default handler (optional)
    require("lspconfig")[server_name].setup {}
  end,
  -- Next, you can provide a dedicated handler for specific servers.
  -- For example, a handler override for the `rust_analyzer`:
  ["tailwindcss"] = function()
    require("lspconfig").tailwindcss.setup {
      root_dir = require("lspconfig").util.root_pattern("tailwind.config.js"),
      lint = {
        unknownAtRules = "ignore",
      },
    }
  end,
  ["svelte"] = function()
    require("lspconfig").svelte.setup {
      on_attach = function(client)
        vim.api.nvim_create_autocmd("BufWritePost", {
          pattern = { "*.js", "*.ts" },
          callback = function(ctx)
            client.notify("$/onDidChangeTsOrJsFile", { uri = ctx.file })
          end,
        })
      end }
  end,
  ["ruff"] = function()
    require("lspconfig").ruff.setup {
      on_attach = function(client)
        client.server_capabilities.hoverProvider = false
      end
    }
  end,
  ["pyright"] = function()
    require("lspconfig").pyright.setup {
      settings = {
        pyright = {
          disableOrganizeImports = true,
        },
        python = {
          analysis = {
            ignore = { "*" },
          },
        },
      }
    }
  end,
}


-- require("mason-lspconfig").setup_handlers {
--   -- The first entry (without a key) will be the default handler
--   -- and will be called for each installed server that doesn't have
--   -- a dedicated handler.
--   function(server_name)        -- default handler (optional)
--     require("lspconfig")[server_name].setup {}
--   end,
--   -- Next, you can provide a dedicated handler for specific servers.
--   -- For example, a handler override for the `rust_analyzer`:
--   ["eslint"] = function()
--     require("eslint").setup({
--     })
--   end
-- }

local augroup = vim.api.nvim_create_augroup('LspFormatting', {})
local lsp_format_on_save = function(bufnr)
  vim.api.nvim_clear_autocmds({ group = augroup, buffer = bufnr })
  vim.api.nvim_create_autocmd('BufWritePre', {
    group = augroup,
    buffer = bufnr,
    callback = function()
      vim.lsp.buf.format()
    end,
  })
end

-- local autocmd_group = vim.api.nvim_create_augroup("Custom auto-commands", { clear = true })
-- vim.api.nvim_create_autocmd({ "BufWritePost" }, {
--   pattern = { "*.py" },
--   desc = "Auto-format Python files after saving",
--   callback = function()
--     local fileName = vim.api.nvim_buf_get_name(0)
--     vim.cmd(":silent !black --preview -q " .. fileName)
--     vim.cmd(":silent !isort --profile black --float-to-top -q " .. fileName)
--     vim.cmd(":silent !docformatter --in-place --black " .. fileName)
--   end,
--   group = autocmd_group,
-- })


local cmp = require('cmp')
local cmp_action = require('lsp-zero').cmp_action()
local cmp_select = { behavior = cmp.SelectBehavior.Select }
cmp.setup({
  window = {
    completion = cmp.config.window.bordered(),
    documentation = cmp.config.window.bordered()
  },
  mapping = cmp.mapping.preset.insert({
    ['<C-p>'] = cmp.mapping.select_prev_item(cmp_select),
    ['<C-n>'] = cmp.mapping.select_next_item(cmp_select),
    ['<C-y>'] = cmp.mapping.confirm({ select = true }),
    ["<C-Space>"] = cmp.mapping.complete(),
  })
})


cmp.setup({
  sources = {
    { name = 'nvim_lsp' }
  }
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

  client.server_capabilities.documentFormattingProvider = true


  lsp_format_on_save(bufnr)

  vim.keymap.set("n", "gd", function() vim.lsp.buf.definition() end, opts)
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

vim.diagnostic.config({
  virtual_text = true
})
