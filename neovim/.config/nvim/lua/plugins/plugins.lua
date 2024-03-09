return {
  {
    'nvim-telescope/telescope.nvim',
    tag = '0.1.4',
    -- or                              , branch = '0.1.x',
    dependencies = { 'nvim-lua/plenary.nvim' }
  },
  {
    'rose-pine/neovim',
    name = 'rose-pine',
    lazy = false,    -- make sure we load this during startup if it is your main colorscheme
    priority = 1000, -- make sure to load this before all the other start plugins
    --   config = function()
    -- load the colorscheme here
    --   vim.cmd([[colorscheme rose-pine]])
    -- end,
  },
  {
    'nvim-treesitter/nvim-treesitter',
    run = ':TSUpdate'
  },
  {
    'ThePrimeagen/harpoon'
  },
  {
    'mbbill/undotree'
  },
  { 'tpope/vim-fugitive' },
  { 'williamboman/mason.nvim' },
  { 'williamboman/mason-lspconfig.nvim' },

  { 'VonHeikemen/lsp-zero.nvim',        branch = 'v3.x' },
  { 'neovim/nvim-lspconfig' },
  { 'hrsh7th/cmp-nvim-lsp' },
  { 'hrsh7th/nvim-cmp' },
  { 'L3MON4D3/LuaSnip' },
  {
    'numToStr/Comment.nvim',
    opts = {
      -- add any options here
    },
    lazy = false,
  },
  { 'github/copilot.vim' },
  {
    "kdheepak/lazygit.nvim",
    -- optional for floating window border decoration
    dependencies = {
      "nvim-lua/plenary.nvim",
    },
  },
  -- {
  --   "nvim-tree/nvim-tree.lua",
  --   version = "*",
  --   lazy = false,
  --   dependencies = {
  --     "nvim-tree/nvim-web-devicons",
  --   },
  --   config = function()
  --     require("nvim-tree").setup {}
  --   end,
  -- },
}
