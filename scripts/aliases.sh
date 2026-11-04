# Source in ~/.bashrc or ~/.zshrc:  source /path/to/clearbrief/scripts/aliases.sh
_CB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

alias cbslim="node \"$_CB_DIR/scripts/slim-cli.js\""
alias cbtest='npm test 2>&1 | node "$_CB_DIR/scripts/slim-cli.js" --raw'
alias cbdiff='git diff -- . ":(exclude)*lock*" ":(exclude)*.map" ":(exclude)dist/*" ":(exclude).next/*" | node "$_CB_DIR/scripts/slim-cli.js" --raw --max-tokens 350'
