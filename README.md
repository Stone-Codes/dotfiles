# dotfiles

Managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Setup

```bash
cd ~/Dev/private/dotfiles  # or wherever you cloned this repo

# Stow everything
stow --target=$HOME neovim zsh tmux starship wezterm tmux-session pi

# Or stow individual packages
stow --target=$HOME neovim
stow --target=$HOME zsh
stow --target=$HOME tmux
stow --target=$HOME starship
stow --target=$HOME wezterm
stow --target=$HOME tmux-session
stow --target=$HOME pi
```

## Packages

| Package | Description |
|---------|-------------|
| `brew` | Brewfile for package management (not stowed) |
| `neovim` | Neovim config (`~/.config/nvim`) |
| `zsh` | Zsh config (`~/.zshrc`) |
| `tmux` | Tmux config (`~/.tmux.conf`) |
| `starship` | Starship prompt config (`~/.config/starship.toml`) |
| `wezterm` | WezTerm config (`~/.config/wezterm`) |
| `tmux-session` | Local tmux session scripts (`~/.local/bin`) |
| `pi` | Pi coding agent extensions, skills, agents, prompts (`~/.pi/agent`) |

## Unstow

```bash
stow --target=$HOME -D pi
```
