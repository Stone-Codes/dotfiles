local wezterm = require 'wezterm'
local act = wezterm.action

local home = os.getenv("HOME")

local config = {}

config.default_prog = { '/opt/homebrew/bin/tmux' }

config.bold_brightens_ansi_colors = true
config.font_size = 16
config.font = wezterm.font("Hack Nerd Font Mono",
  { weight = "Bold", italic = false })

config.window_background_image = home .. '/.config/wezterm/wezbg.png'

config.window_background_image_hsb = {
  -- Darken the background image by reducing it to 1/3rd
  brightness = 0.03,

  -- You can adjust the hue by scaling its value.
  -- a multiplier of 1.0 leaves the value unchanged.
  hue = 1.0,

  -- You can adjust the saturation also.
  saturation = 1.0,
}

config.keys = {
  -- paste from the clipboard
  { key = 'V', mods = 'CTRL', action = act.PasteFrom 'Clipboard' },
}
return config
