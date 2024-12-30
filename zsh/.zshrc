export PATH=/opt/homebrew/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/shims:$PATH"

if which pyenv > /dev/null; then eval "$(pyenv init -)"; fi

export WORKON_HOME=$HOME/.virtualenvs
# source /Users/adminfd/.pyenv/shims/virtualenvwrapper.sh
# export VIRTUALENVWRAPPER_PYTHON=/Users/adminfd/.pyenv/shims/python
# export /Users/adminfd/.pyenv/versions/3.10.13/bin/virtualenv
source /Users/adminfd/.pyenv/versions/3.10.13/bin/virtualenvwrapper.sh


export PATH="/opt/homebrew/opt/libpq/bin:$PATH"

# pnpm
export PNPM_HOME="/Users/adminfd/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# proto
# export PROTO_HOME="$HOME/.proto"
# export PATH="$PROTO_HOME/shims:$PROTO_HOME/bin:$PATH"

# export PATH=$PATH:/usr/local/go/bin
export GOPATH=$HOME/go
export PATH=$PATH:$GOPATH/bin
eval "$(starship init zsh)"
eval "$(zoxide init --cmd cd zsh)"

# The next line updates PATH for the Google Cloud SDK.
if [ -f '/Users/adminfd/Downloads/google-cloud-sdk/path.zsh.inc' ]; then . '/Users/adminfd/Downloads/google-cloud-sdk/path.zsh.inc'; fi

# The next line enables shell command completion for gcloud.
if [ -f '/Users/adminfd/Downloads/google-cloud-sdk/completion.zsh.inc' ]; then . '/Users/adminfd/Downloads/google-cloud-sdk/completion.zsh.inc'; fi

alias air='$(go env GOPATH)/bin/air'
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
