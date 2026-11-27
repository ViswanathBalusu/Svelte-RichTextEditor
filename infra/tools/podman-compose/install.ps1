# Installs the pinned podman-compose into infra/tools/podman-compose/.venv (ignored by git) with hash checking,
# and prints the path of the compose executable. Use it as the provider with:
#   $env:PODMAN_COMPOSE_PROVIDER = '<printed path>'; podman compose version
param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$venv = Join-Path $here '.venv'
if (-not (Test-Path $venv)) { & $Python -m venv $venv; if ($LASTEXITCODE) { throw 'venv failed' } }
$py = if ($IsLinux -or $IsMacOS) { Join-Path $venv 'bin/python' } else { Join-Path $venv 'Scripts/python.exe' }
& $py -m pip install --require-hashes --no-deps -r (Join-Path $here 'requirements.txt') --quiet
if ($LASTEXITCODE) { throw 'pip install failed (hash mismatch or missing wheel)' }
$exe = if ($IsLinux -or $IsMacOS) { Join-Path $venv 'bin/podman-compose' } else { Join-Path $venv 'Scripts/podman-compose.exe' }
Write-Output $exe
