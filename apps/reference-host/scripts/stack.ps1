#Requires -Version 7.2
<#
.SYNOPSIS
  The reference host's demo stack (BE-005, UX-091): PostgreSQL, an S3-compatible store, the
  document service, the export worker and the reference host, seeded with a tenant, users and
  documents. Demo only: not a production deployment.

.DESCRIPTION
  up      Start whatever is not running and wait until each part is ready: the two containers,
          the set-up (secrets, bucket, database, migrations, tenant registration), the document
          service, the seed (documents and the host's catalogue), the reference host and, when it
          exists, the export worker with its sandbox image.
  down    Stop the processes and remove the containers. The volumes and the data directory stay,
          so documents and their history are intact at the next `up` (BE-005 criterion 5).
          With -Volumes, remove them too: the next `up` starts from the seeded state (UX-091
          criterion 7).
  reset   down -Volumes, then up.
  status  Show each part and whether it is ready.
  logs    Show the last lines of each process's log (or of the one named after `logs`).
  kit     Run the conformance kit's `core` profile (or the profiles named after `kit`, comma-
          separated) against the stack's discovery URL with the host's service credential
          (BE-005 criterion 3; PRO-108). Reports go to the data directory.

  Definitions: apps/reference-host/compose.json, a compose file (JSON is valid YAML). Containers are
  started with `podman run` because Compose cannot pass --cgroups=disabled, which a WSL Podman
  machine needs; services marked `x-docedit-process` run as local Node.js processes with the
  same commands. Everything binds 127.0.0.1 through host networking, as in infra/test-env.ps1.
  Settings: stack/.env.example, then stack/.env, then the environment.

  DOCEDIT_CONTAINER_CLI     container CLI (default podman)
  DOCEDIT_CONTAINER_CGROUPS enabled or disabled; default disabled when Podman runs in a machine
  DOCEDIT_DEMO_DATA         the data directory (default apps/reference-host/.stack)

.EXAMPLE
  pwsh -NoProfile -File apps/reference-host/scripts/stack.ps1 up
.EXAMPLE
  pwsh -NoProfile -File apps/reference-host/scripts/stack.ps1 down -Volumes
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'down', 'reset', 'status', 'logs', 'kit')]
  [string]$Command = 'status',

  [Parameter(Position = 1)]
  [string]$Name,

  # down: also remove the volumes and the data directory.
  [switch]$Volumes,
  # up: build the element and the host even when a build exists.
  [switch]$Build,
  # up: do not start the export worker or build its image.
  [switch]$NoExport
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$AppDir = Split-Path -Parent $PSScriptRoot
$RepoDir = (Resolve-Path (Join-Path $AppDir '..\..')).Path
$ComposeFile = Join-Path $AppDir 'compose.json'
$DataDir = if ($env:DOCEDIT_DEMO_DATA) { $env:DOCEDIT_DEMO_DATA } else { Join-Path $AppDir '.stack' }
$LogDir = Join-Path $DataDir 'logs'
$PidDir = Join-Path $DataDir 'pids'

function Read-EnvFile([string]$Path) {
  $map = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { throw "${Path}: expected KEY=VALUE, found: $line" }
    $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
  }
  return $map
}

function Get-Settings {
  $s = Read-EnvFile (Join-Path $AppDir 'stack\.env.example')
  $local = Read-EnvFile (Join-Path $AppDir 'stack\.env')
  foreach ($k in $local.Keys) { $s[$k] = $local[$k] }
  foreach ($k in @($s.Keys)) {
    $v = [Environment]::GetEnvironmentVariable($k)
    if ($v) { $s[$k] = $v }
  }
  return $s
}

$Settings = Get-Settings
$Cli = if ($Settings['DOCEDIT_CONTAINER_CLI']) { $Settings['DOCEDIT_CONTAINER_CLI'] } else { 'podman' }

function Expand-Setting([string]$Text) {
  return [regex]::Replace($Text, '\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}', {
      param($m)
      $n = $m.Groups[1].Value
      if ($Settings.Contains($n) -and $Settings[$n] -ne '') { return [string]$Settings[$n] }
      if ($m.Groups[2].Success) { return $m.Groups[2].Value }
      throw "compose.json uses `${$n}, which is not set"
    })
}

function Test-Key($Map, [string]$Key) { return $null -ne $Map -and $Map.Keys -contains $Key }

function Invoke-Cli([string[]]$Arguments, [switch]$AllowFailure) {
  $out = & $Cli @Arguments 2>&1
  $code = $LASTEXITCODE
  $text = ($out | ForEach-Object { "$_" }) -join "`n"
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "$Cli $($Arguments -join ' ') failed with exit code ${code}:`n$text"
  }
  return [pscustomobject]@{ Code = $code; Output = $text }
}

function Get-CgroupsMode {
  if ($env:DOCEDIT_CONTAINER_CGROUPS) { return $env:DOCEDIT_CONTAINER_CGROUPS }
  $remote = (Invoke-Cli @('info', '--format', '{{.Host.ServiceIsRemote}}') -AllowFailure).Output.Trim()
  if ($remote -eq 'true') { return 'disabled' }
  return 'enabled'
}

function ConvertTo-Milliseconds([string]$Duration) {
  if ($Duration -match '^(\d+)ms$') { return [int]$Matches[1] }
  if ($Duration -match '^(\d+)s$') { return [int]$Matches[1] * 1000 }
  throw "unsupported duration: $Duration"
}

function Get-Definition { return Get-Content -LiteralPath $ComposeFile -Raw | ConvertFrom-Json -AsHashtable }

$Def = Get-Definition
$Project = if ($Settings['DOCEDIT_DEMO_PROJECT']) { $Settings['DOCEDIT_DEMO_PROJECT'] } else { $Def['name'] }

function Get-ContainerName([string]$Service) { return "$Project-$Service" }

function Get-ContainerState([string]$ContainerName) {
  $r = Invoke-Cli @('container', 'inspect', '--format', '{{.State.Status}}', $ContainerName) -AllowFailure
  if ($r.Code -ne 0) { return 'absent' }
  return $r.Output.Trim()
}

# A named volume of compose.json becomes <project>-<name>, as Compose names it.
function Expand-Volume([string]$Spec) {
  $v = Expand-Setting $Spec
  $parts = $v.Split(':')
  if ($parts[0] -notmatch '[/\\]' -and $Def['volumes'].Keys -contains $parts[0]) {
    $parts[0] = "$Project-$($parts[0])"
  }
  return $parts -join ':'
}

function Get-RunArguments([string]$Service, $Svc, [string]$Cgroups) {
  $a = [System.Collections.Generic.List[string]]::new()
  $a.AddRange([string[]]@('run', '--detach', "--name=$(Get-ContainerName $Service)"))
  $a.Add("--label=org.docedit.project=$Project")
  $a.Add("--label=org.docedit.service=$Service")
  if ($Cgroups -eq 'disabled') { $a.Add('--cgroups=disabled') }
  if (Test-Key $Svc 'network_mode') { $a.Add("--network=$($Svc['network_mode'])") }
  if (Test-Key $Svc 'environment') {
    foreach ($k in $Svc['environment'].Keys) { $a.Add("--env=$k=$(Expand-Setting $Svc['environment'][$k])") }
  }
  if (Test-Key $Svc 'volumes') { foreach ($v in $Svc['volumes']) { $a.Add("--volume=$(Expand-Volume $v)") } }
  if (Test-Key $Svc 'tmpfs') { foreach ($t in $Svc['tmpfs']) { $a.Add("--tmpfs=$(Expand-Setting $t)") } }
  if ((Test-Key $Svc 'read_only') -and $Svc['read_only']) { $a.Add('--read-only') }
  if (Test-Key $Svc 'cap_drop') { foreach ($c in $Svc['cap_drop']) { $a.Add("--cap-drop=$c") } }
  if (Test-Key $Svc 'security_opt') { foreach ($o in $Svc['security_opt']) { $a.Add("--security-opt=$o") } }
  if (Test-Key $Svc 'user') { $a.Add("--user=$($Svc['user'])") }
  if (Test-Key $Svc 'labels') { foreach ($k in $Svc['labels'].Keys) { $a.Add("--label=$k=$($Svc['labels'][$k])") } }
  $a.Add((Expand-Setting $Svc['image']))
  if (Test-Key $Svc 'command') { foreach ($c in $Svc['command']) { $a.Add((Expand-Setting $c)) } }
  return , $a.ToArray()
}

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    return $task.Wait(500) -and $client.Connected
  } catch { return $false }
  finally { $client.Dispose() }
}

function Wait-Container([string]$Service, [int]$Port) {
  $svc = $Def['services'][$Service]
  $name = Get-ContainerName $Service
  $hc = $svc['healthcheck']
  $test = @($hc['test'] | Select-Object -Skip 1 | ForEach-Object { Expand-Setting $_ })
  $interval = ConvertTo-Milliseconds $hc['interval']
  $retries = [int]$hc['retries']
  for ($i = 0; $i -lt $retries; $i++) {
    $r = Invoke-Cli (@('exec', $name) + $test) -AllowFailure
    if ($r.Code -eq 0 -and (Test-TcpPort '127.0.0.1' $Port)) { return }
    $state = Get-ContainerState $name
    if ($state -ne 'running') {
      $logs = (Invoke-Cli @('logs', '--tail', '40', $name) -AllowFailure).Output
      throw "$Service is $state instead of running. Last log lines:`n$logs"
    }
    Start-Sleep -Milliseconds $interval
  }
  throw "$Service was not ready after $retries checks (inside the container and on 127.0.0.1:$Port)"
}

function Start-Container([string]$Service, [int]$Port, [string]$Cgroups) {
  $name = Get-ContainerName $Service
  $state = Get-ContainerState $name
  if ($state -eq 'running') { return 'running' }
  if ($state -ne 'absent') {
    # A stopped container of an earlier run: start it again with its volumes.
    Invoke-Cli @('start', $name) | Out-Null
    return 'started'
  }
  if (Test-TcpPort '127.0.0.1' $Port) {
    throw "${Service}: 127.0.0.1:$Port is already in use by something else; set another port in apps/reference-host/stack/.env"
  }
  Invoke-Cli (Get-RunArguments $Service $Def['services'][$Service] $Cgroups) | Out-Null
  return 'created'
}

# --- Local Node.js processes for the services marked x-docedit-process.

function Get-NodeCommand([string]$Service) {
  $cmd = @($Def['services'][$Service]['command'] | ForEach-Object { Expand-Setting $_ })
  if ($cmd[0] -ne 'node') { throw "${Service}: only node commands run as local processes" }
  return , @($cmd | Select-Object -Skip 1)
}

function Get-ProcessOf([string]$Service) {
  $file = Join-Path $PidDir "$Service.pid"
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $id = [int](Get-Content -LiteralPath $file -Raw).Trim()
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -match '^node') { return $p }
  return $null
}

function Start-NodeProcess([string]$Service) {
  if (Get-ProcessOf $Service) { return 'running' }
  New-Item -ItemType Directory -Force -Path $LogDir, $PidDir | Out-Null
  $arguments = Get-NodeCommand $Service
  # Detached, with only its log files, so that a caller whose output is a pipe (CI) is not kept
  # waiting. On Windows a child inherits every inheritable handle of its parent, so the launcher
  # itself is started through the shell, which passes it none of this script's handles.
  $spawn = @(
    (Join-Path $PSScriptRoot 'spawn.ts'),
    (Join-Path $PidDir "$Service.pid"),
    (Join-Path $LogDir "$Service.log"),
    (Join-Path $LogDir "$Service.err.log")
  ) + $arguments
  if ($IsWindows) {
    $p = Start-Process -FilePath 'node' -ArgumentList $spawn -WorkingDirectory $RepoDir -WindowStyle Hidden -PassThru
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "${Service}: the process did not start (exit code $($p.ExitCode))" }
  } else {
    Push-Location $RepoDir
    try {
      & node @spawn
      if ($LASTEXITCODE -ne 0) { throw "${Service}: the process did not start" }
    } finally { Pop-Location }
  }
  return 'started'
}

function Invoke-NodeStep([string]$Service) {
  $arguments = Get-NodeCommand $Service
  Push-Location $RepoDir
  try {
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw "$Service failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Wait-Http([string]$Url, [string]$Service, [int]$Seconds = 60) {
  $until = (Get-Date).AddSeconds($Seconds)
  $last = 'no answer'
  while ((Get-Date) -lt $until) {
    try {
      $r = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -SkipHttpErrorCheck
      if ($r.StatusCode -eq 200) { return }
      $last = "HTTP $($r.StatusCode) $($r.Content)"
    } catch { $last = $_.Exception.Message }
    if (-not (Get-ProcessOf $Service)) {
      $err = Get-Content -LiteralPath (Join-Path $LogDir "$Service.err.log") -Tail 30 -ErrorAction SilentlyContinue
      throw "$Service stopped. Last lines of its error log:`n$($err -join "`n")"
    }
    Start-Sleep -Milliseconds 500
  }
  throw "$Service was not ready at $Url after $Seconds s: $last"
}

function Stop-NodeProcess([string]$Service) {
  $p = Get-ProcessOf $Service
  if ($p) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $p.WaitForExit(5000) | Out-Null
  }
  Remove-Item -LiteralPath (Join-Path $PidDir "$Service.pid") -Force -ErrorAction SilentlyContinue
  return [bool]$p
}

# --- Builds and the export worker.

function Invoke-Pnpm([string[]]$Arguments) {
  $env:Path = "$(npm prefix -g);$env:Path"
  Push-Location $RepoDir
  try {
    & pnpm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Initialize-Builds {
  $element = Join-Path $RepoDir 'packages\element\dist\lib\doc-editor.js'
  if ($Build -or -not (Test-Path -LiteralPath $element)) { Invoke-Pnpm @('--filter', '@docedit/element', 'build') }
  $hostBuild = Join-Path $AppDir 'dist\host\handler.js'
  if ($Build -or -not (Test-Path -LiteralPath $hostBuild)) { Invoke-Pnpm @('--filter', '@docedit/reference-host', 'build') }
}

function Get-PodmanMachine {
  if ($Settings['DOCEDIT_PODMAN_MACHINE']) { return $Settings['DOCEDIT_PODMAN_MACHINE'] }
  $remote = (Invoke-Cli @('info', '--format', '{{.Host.ServiceIsRemote}}') -AllowFailure).Output.Trim()
  if ($remote -ne 'true') { return '' }
  $list = (Invoke-Cli @('machine', 'list', '--format', 'json') -AllowFailure).Output
  try {
    $running = @($list | ConvertFrom-Json | Where-Object { $_.Running })
    if ($running.Count -gt 0) { return ($running[0].Name -replace '\*$', '') }
  } catch { }
  return ''
}

function Initialize-ExportWorker {
  $main = Join-Path $RepoDir 'services\export-worker\src\main.ts'
  if (-not (Test-Path -LiteralPath $main)) { return 'not started: services/export-worker/src/main.ts does not exist yet' }
  $svc = $Def['services']['export-sandbox']
  $image = Expand-Setting $svc['image']
  if ((Invoke-Cli @('image', 'exists', $image) -AllowFailure).Code -ne 0) {
    $context = [IO.Path]::GetFullPath((Join-Path $AppDir $svc['build']['context']))
    $file = [IO.Path]::GetFullPath((Join-Path $context $svc['build']['dockerfile']))
    Invoke-Cli @('build', '--file', $file, '--tag', $image, $context) | Out-Null
  }
  $machine = Get-PodmanMachine
  if ($machine) { $env:DOCEDIT_PODMAN_MACHINE = $machine }
  $state = Start-NodeProcess 'export-worker'
  # The worker exits with a logged reason when its sandbox cannot run here.
  Start-Sleep -Seconds 5
  if (-not (Get-ProcessOf 'export-worker')) {
    $err = Get-Content -LiteralPath (Join-Path $LogDir 'export-worker.err.log') -Tail 10 -ErrorAction SilentlyContinue
    $out = Get-Content -LiteralPath (Join-Path $LogDir 'export-worker.log') -Tail 10 -ErrorAction SilentlyContinue
    return "stopped after start: $((@($out) + @($err)) -join ' | ')"
  }
  return "$state (image $image$(if ($machine) { ", sandbox through machine $machine" }))"
}

# --- Commands.

function Start-Stack {
  $t0 = Get-Date
  $cgroups = Get-CgroupsMode
  $pg = [int]$Settings['DOCEDIT_DEMO_PG_PORT']
  $s3 = [int]$Settings['DOCEDIT_DEMO_S3_PORT']
  $servicePort = $Settings['DOCEDIT_DEMO_SERVICE_PORT']
  $hostPort = $Settings['DOCEDIT_DEMO_HOST_PORT']
  $states = [ordered]@{}
  $states['postgres'] = Start-Container 'postgres' $pg $cgroups
  $states['s3'] = Start-Container 's3' $s3 $cgroups
  Wait-Container 'postgres' $pg
  Wait-Container 's3' $s3
  Initialize-Builds
  Invoke-NodeStep 'setup'
  $states['document-service'] = Start-NodeProcess 'document-service'
  Wait-Http "http://127.0.0.1:$servicePort/readyz" 'document-service'
  Invoke-NodeStep 'seed'
  $states['reference-host'] = Start-NodeProcess 'reference-host'
  Wait-Http "http://127.0.0.1:$hostPort/healthz" 'reference-host'
  $states['export-worker'] = if ($NoExport) { 'not started (-NoExport)' } else { Initialize-ExportWorker }
  $seconds = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  Write-Host "demo stack '$Project' is up in $seconds s (cgroups $cgroups). Demo only: not a production deployment."
  foreach ($k in $states.Keys) { Write-Host ("  {0,-17} {1}" -f $k, $states[$k]) }
  Write-Host "  postgres          127.0.0.1:$pg"
  Write-Host "  s3                http://127.0.0.1:$s3 bucket $($Settings['DOCEDIT_DEMO_S3_BUCKET'])"
  Write-Host "  document service  http://127.0.0.1:$servicePort (discovery: /.well-known/dep)"
  Write-Host "  reference host    http://127.0.0.1:$hostPort/  <- open this, choose a person"
  Write-Host "  data and logs     $DataDir"
}

function Stop-Stack {
  $stopped = @()
  foreach ($service in @('export-worker', 'reference-host', 'document-service')) {
    if (Stop-NodeProcess $service) { $stopped += $service }
  }
  $names = (Invoke-Cli @('ps', '--all', '--filter', "label=org.docedit.project=$Project", '--format', '{{.Names}}')).Output -split "`n" |
    Where-Object { $_.Trim() -ne '' }
  if ($names) { Invoke-Cli (@('rm', '--force', '--time', '5') + $names) | Out-Null }
  $removed = 'kept'
  if ($Volumes) {
    foreach ($v in $Def['volumes'].Keys) { Invoke-Cli @('volume', 'rm', '--force', "$Project-$v") -AllowFailure | Out-Null }
    Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    $removed = 'removed, with the data directory'
  }
  Write-Host "demo stack '$Project' is down: processes stopped: $(if ($stopped) { $stopped -join ', ' } else { 'none' }); containers removed: $(@($names).Count); volumes $removed"
}

function Show-Status {
  foreach ($service in @('postgres', 's3')) {
    Write-Host ("{0,-17} {1}" -f $service, (Get-ContainerState (Get-ContainerName $service)))
  }
  $urls = @{
    'document-service' = "http://127.0.0.1:$($Settings['DOCEDIT_DEMO_SERVICE_PORT'])/readyz"
    'reference-host'   = "http://127.0.0.1:$($Settings['DOCEDIT_DEMO_HOST_PORT'])/healthz"
  }
  foreach ($service in @('document-service', 'reference-host', 'export-worker')) {
    $p = Get-ProcessOf $service
    $state = if ($p) { "running (pid $($p.Id))" } else { 'stopped' }
    if ($p -and $urls.ContainsKey($service)) {
      try {
        $r = Invoke-WebRequest -Uri $urls[$service] -TimeoutSec 3 -SkipHttpErrorCheck
        $state += $(if ($r.StatusCode -eq 200) { ', ready' } else { ", not ready (HTTP $($r.StatusCode))" })
      } catch { $state += ', not answering' }
    }
    Write-Host ("{0,-17} {1}" -f $service, $state)
  }
  $image = Expand-Setting $Def['services']['export-sandbox']['image']
  $exists = (Invoke-Cli @('image', 'exists', $image) -AllowFailure).Code -eq 0
  Write-Host ("{0,-17} {1}" -f 'export-sandbox', $(if ($exists) { "image $image present" } else { "image $image absent" }))
}

function Show-Logs {
  $names = if ($Name) { @($Name) } else { @('document-service', 'reference-host', 'export-worker') }
  foreach ($n in $names) {
    foreach ($suffix in @('log', 'err.log')) {
      $f = Join-Path $LogDir "$n.$suffix"
      if (Test-Path -LiteralPath $f) {
        Write-Host "== $n.$suffix"
        Get-Content -LiteralPath $f -Tail 30
      }
    }
  }
}

function Invoke-Kit {
  $secrets = Get-Content -LiteralPath (Join-Path $DataDir 'secrets.json') -Raw | ConvertFrom-Json
  $profiles = if ($Name) { $Name } else { 'core' }
  $json = Join-Path $DataDir "kit-$($profiles -replace '[^a-z0-9-]', '_').json"
  $text = Join-Path $DataDir "kit-$($profiles -replace '[^a-z0-9-]', '_').txt"
  # The credential goes through the environment, never the command line (the kit's own rule).
  $env:DEP_TCK_CREDENTIAL = $secrets.apiKey.credential
  try {
    Push-Location $RepoDir
    & node packages/tck/src/cli.ts --discovery "http://127.0.0.1:$($Settings['DOCEDIT_DEMO_SERVICE_PORT'])" `
      --origin "http://127.0.0.1:$($Settings['DOCEDIT_DEMO_HOST_PORT'])" --profile $profiles --json $json --text $text
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    Remove-Item Env:\DEP_TCK_CREDENTIAL -ErrorAction SilentlyContinue
  }
  Write-Host "conformance kit ($profiles): exit code $code; reports $json and $text"
  exit $code
}

switch ($Command) {
  'up' { Start-Stack }
  'down' { Stop-Stack }
  'reset' { $Volumes = $true; Stop-Stack; Start-Stack }
  'status' { Show-Status }
  'logs' { Show-Logs }
  'kit' { Invoke-Kit }
}
