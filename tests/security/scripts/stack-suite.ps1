#Requires -Version 7.2
<#
.SYNOPSIS
  Runs the adversarial client's suite against the compose stack of BE-005 (SEC-002 criterion 5).

.DESCRIPTION
  Starts the stack of apps/reference-host/compose.json with apps/reference-host/scripts/stack.ps1
  (PostgreSQL, the S3-compatible store, the document service, the reference host and the export
  worker), runs the suite against it with DOCEDIT_DEMO_STACK=1, and removes the stack with its
  volumes whatever the outcome. Exits with the suite's exit code. This is the one command a CI
  job needs; `infra/test-env.ps1 run` is the same idea for the integration environment.

  The stack gets its own project name, ports and data directory, so that it never touches a demo
  stack a person is using (whose volumes `down -Volumes` would remove). Each is taken from the
  environment when set there:

  DOCEDIT_DEMO_PROJECT       default docedit-sec-stack
  DOCEDIT_DEMO_PG_PORT       default 57432
  DOCEDIT_DEMO_S3_PORT       default 57470
  DOCEDIT_DEMO_SERVICE_PORT  default 57480
  DOCEDIT_DEMO_HOST_PORT     default 57490
  DOCEDIT_DEMO_DATA          default <temp>/<project>

  Without test files, the suite is tests/security/test/adversarial-client.test.ts.

.EXAMPLE
  pwsh -NoProfile -File tests/security/scripts/stack-suite.ps1
.EXAMPLE
  pwsh -NoProfile -File tests/security/scripts/stack-suite.ps1 -NoExport
#>
[CmdletBinding()]
param(
  # Do not start the export worker or build its image (the client's suite does not use it).
  [switch]$NoExport,
  # Leave the stack running afterwards, for a second run or a look at its logs.
  [switch]$Keep,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Tests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$Stack = Join-Path $RepoDir 'apps\reference-host\scripts\stack.ps1'

$defaults = [ordered]@{
  DOCEDIT_DEMO_PROJECT      = 'docedit-sec-stack'
  DOCEDIT_DEMO_PG_PORT      = '57432'
  DOCEDIT_DEMO_S3_PORT      = '57470'
  DOCEDIT_DEMO_SERVICE_PORT = '57480'
  DOCEDIT_DEMO_HOST_PORT    = '57490'
}
foreach ($name in $defaults.Keys) {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    [Environment]::SetEnvironmentVariable($name, $defaults[$name])
  }
}
if (-not $env:DOCEDIT_DEMO_DATA) {
  $env:DOCEDIT_DEMO_DATA = Join-Path ([IO.Path]::GetTempPath()) $env:DOCEDIT_DEMO_PROJECT
}
$env:DOCEDIT_DEMO_STACK = '1'

$files = @($Tests | Where-Object { $_ -and $_ -ne '--' })
if ($files.Count -eq 0) { $files = @('tests/security/test/adversarial-client.test.ts') }

$code = 1
try {
  $up = @('-NoProfile', '-File', $Stack, 'up')
  if ($NoExport) { $up += '-NoExport' }
  & pwsh @up
  if ($LASTEXITCODE -ne 0) { throw "the stack '$($env:DOCEDIT_DEMO_PROJECT)' did not start" }

  if ($IsWindows) { $env:Path = "$(npm prefix -g);$env:Path" }
  Push-Location $RepoDir
  try {
    # Splat a variable: an inline @(...) would reach a PowerShell shim (pnpm.ps1) as one argument.
    $arguments = @('exec', 'vitest', 'run', '--project', 'node') + $files
    & pnpm @arguments
    $code = $LASTEXITCODE
  } finally { Pop-Location }
} finally {
  if ($Keep) {
    Write-Host "the stack '$($env:DOCEDIT_DEMO_PROJECT)' is left running (data: $($env:DOCEDIT_DEMO_DATA))"
  } else {
    & pwsh -NoProfile -File $Stack down -Volumes
  }
}
Write-Host "stack suite: exit code $code"
exit $code
