# Dot-source in PowerShell $PROFILE:  . "C:\path\to\clearbrief\scripts\aliases.ps1"
$Script:ClearBriefRoot = Split-Path -Parent $PSScriptRoot

function Invoke-CbSlim {
  param([int]$MaxTokens = 220, [switch]$Raw)
  $extra = @('--max-tokens', $MaxTokens)
  if ($Raw) { $extra += '--raw' }
  $input | node "$Script:ClearBriefRoot\scripts\slim-cli.js" @extra
}

function Invoke-CbDiff {
  git diff -- . ":(exclude)*lock*" ":(exclude)*.map" ":(exclude)dist/*" ":(exclude).next/*" |
    node "$Script:ClearBriefRoot\scripts\slim-cli.js" --raw --max-tokens 350
}

Set-Alias -Name cbslim -Value Invoke-CbSlim
Set-Alias -Name cbdiff -Value Invoke-CbDiff
