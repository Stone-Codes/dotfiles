require('Comment').setup({
    toggler = {
        ---Line-comment toggle keymap
        line = '<leader>/',
        ---Block-comment toggle keymap
        block = '<leader>?',  -- Optional: Set a different keybind for block comments
    },
    opleader = {
    --     ---Line-comment keymap for VISUAL mode
        line = '<leader>/',
    --     ---Block-comment keymap for VISUAL mode
        block = '<leader>?',  -- Optional: Set a different keybind for block comments in visual mode
     },
})
