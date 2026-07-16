local function open_avante_guide()
  vim.cmd.edit(vim.fn.stdpath("config") .. "/AVANTE.md")
end

vim.keymap.set("n", "<leader>aa", "<cmd>AvanteToggle<CR>", { desc = "Avante: toggle sidebar" })
vim.keymap.set({ "n", "v" }, "<leader>ac", "<cmd>AvanteAsk<CR>", { desc = "Avante: ask Codex" })
vim.keymap.set("v", "<leader>aa", "<cmd>AvanteAsk<CR>", { desc = "Avante: ask about selection" })
vim.keymap.set("n", "<leader>af", "<cmd>AvanteFocus<CR>", { desc = "Avante: focus sidebar" })
vim.keymap.set("n", "<leader>ar", "<cmd>AvanteRefresh<CR>", { desc = "Avante: refresh" })
vim.keymap.set("n", "<leader>as", "<cmd>AvanteStop<CR>", { desc = "Avante: stop request" })
vim.keymap.set("n", "<leader>ax", "<cmd>AvanteClear<CR>", { desc = "Avante: clear conversation" })
vim.keymap.set("n", "<leader>ah", open_avante_guide, { desc = "Avante: open guide" })
