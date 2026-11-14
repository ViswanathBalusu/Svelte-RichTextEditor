# Runs a pnpm command while holding the workspace install lock, so that agents working in parallel
# never run two installs at once (they share pnpm-lock.yaml and node_modules).
# Usage: pwsh -NoProfile -File scripts/pnpm-locked.ps1 add --filter @docedit/engine some-package@1.2.3
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PnpmArgs)

$lock = Join-Path $PSScriptRoot '..\.install-lock'
$deadline = (Get-Date).AddMinutes(10)
while ($true) {
  try {
    New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
    break
  } catch {
    if ((Get-Date) -gt $deadline) { throw "The install lock $lock has been held for 10 minutes. Remove it only if no install is running." }
    Start-Sleep -Milliseconds 500
  }
}
try {
  $env:Path = "$(npm prefix -g);$env:Path"
  Set-Location (Join-Path $PSScriptRoot '..')
  & pnpm @PnpmArgs
  exit $LASTEXITCODE
} finally {
  Remove-Item $lock -Force -Recurse -ErrorAction SilentlyContinue
}
