#Requires -Version 7.2
<#
.SYNOPSIS
  The integration-test environment (FND-010): PostgreSQL, an S3-compatible store and the export
  worker, started from the definitions in infra/containers/compose.json.

.DESCRIPTION
  up      Start whatever is not running, wait until it is ready, create the test bucket, build
          the export worker image and run one compile job in its sandbox without network.
  down    Remove the containers. Data lives on tmpfs, so nothing is left behind.
  reset   down, then up: a clean state.
  status  Show the containers and whether each is ready.
  run     reset, run the command given after the command name, then down whatever happened.
          Exits with the command's exit code. This is the form CI uses.

  Definitions: infra/containers/compose.json, a compose file (JSON is valid YAML). This script
  starts the same services with `podman run` because Compose cannot pass --cgroups=disabled,
  which the WSL Podman machine needs (its systemd cgroup manager delegates no controllers).
  Settings and test credentials: infra/containers/.env.example, then .env next to it, then the
  environment. Everything binds 127.0.0.1 through host networking: on the WSL machine published
  ports are DNAT rules that WSL's localhost relay cannot see, while a socket bound to loopback in
  the VM is relayed to Windows' loopback.

  DOCEDIT_CONTAINER_CLI     container CLI (default podman)
  DOCEDIT_CONTAINER_CGROUPS enabled or disabled; default disabled when Podman runs in a machine
                            (podman info: serviceIsRemote), enabled otherwise.

.EXAMPLE
  pwsh -NoProfile -File infra/test-env.ps1 up
.EXAMPLE
  pwsh -NoProfile -File infra/test-env.ps1 run pnpm test
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'down', 'reset', 'status', 'run')]
  [string]$Command = 'status',

  # Skip building and checking the export worker image (it is large; the storage tests do not need it).
  [switch]$NoExport,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$DefsDir = Join-Path $PSScriptRoot 'containers'
$ComposeFile = Join-Path $DefsDir 'compose.json'

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
  $s = Read-EnvFile (Join-Path $DefsDir '.env.example')
  $local = Read-EnvFile (Join-Path $DefsDir '.env')
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
      $name = $m.Groups[1].Value
      if ($Settings.Contains($name) -and $Settings[$name] -ne '') { return [string]$Settings[$name] }
      if ($m.Groups[2].Success) { return $m.Groups[2].Value }
      throw "compose.json uses `${$name}, which is not set"
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

function Get-Definition {
  return Get-Content -LiteralPath $ComposeFile -Raw | ConvertFrom-Json -AsHashtable
}

function Get-ContainerName([string]$Project, [string]$Service) { return "$Project-$Service" }

function Get-ContainerState([string]$Name) {
  $r = Invoke-Cli @('container', 'inspect', '--format', '{{.State.Status}}', $Name) -AllowFailure
  if ($r.Code -ne 0) { return 'absent' }
  return $r.Output.Trim()
}

function Get-RunArguments([string]$Project, [string]$Service, $Svc, [string]$Cgroups, [switch]$Job) {
  $a = [System.Collections.Generic.List[string]]::new()
  $name = Get-ContainerName $Project $Service
  if ($Job) { $a.AddRange([string[]]@('run', '--rm', '--interactive', "--name=$name-job")) }
  else { $a.AddRange([string[]]@('run', '--detach', "--name=$name")) }
  $a.Add("--label=org.docedit.project=$Project")
  $a.Add("--label=org.docedit.service=$Service")
  if ($Cgroups -eq 'disabled') { $a.Add('--cgroups=disabled') }
  if (Test-Key $Svc 'network_mode') { $a.Add("--network=$($Svc['network_mode'])") }
  if (Test-Key $Svc 'environment') {
    foreach ($k in $Svc['environment'].Keys) { $a.Add("--env=$k=$(Expand-Setting $Svc['environment'][$k])") }
  }
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

function Wait-Ready([string]$Project, [string]$Service, $Svc, [string]$HostName, [int]$Port) {
  $name = Get-ContainerName $Project $Service
  $hc = $Svc['healthcheck']
  $test = @($hc['test'] | Select-Object -Skip 1 | ForEach-Object { Expand-Setting $_ })
  $interval = ConvertTo-Milliseconds $hc['interval']
  $retries = [int]$hc['retries']
  for ($i = 0; $i -lt $retries; $i++) {
    $r = Invoke-Cli (@('exec', $name) + $test) -AllowFailure
    if ($r.Code -eq 0 -and (Test-TcpPort $HostName $Port)) { return }
    $state = Get-ContainerState $name
    if ($state -ne 'running') {
      $logs = (Invoke-Cli @('logs', '--tail', '40', $name) -AllowFailure).Output
      throw "$Service is $state instead of running. Last log lines:`n$logs"
    }
    Start-Sleep -Milliseconds $interval
  }
  throw "$Service was not ready after $retries checks (inside the container and on ${HostName}:$Port)"
}

# --- S3 requests signed with AWS Signature Version 4 (enough for bucket set-up and a smoke test).

function Get-Sha256Hex([byte[]]$Bytes) {
  return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-HmacSha256([byte[]]$Key, [string]$Text) {
  return [System.Security.Cryptography.HMACSHA256]::HashData($Key, [Text.Encoding]::UTF8.GetBytes($Text))
}

function Invoke-S3([string]$Method, [string]$Path, [byte[]]$Body = [byte[]]::new(0)) {
  $hostHeader = "$($Settings['DOCEDIT_S3_HOST']):$($Settings['DOCEDIT_S3_PORT'])"
  $region = $Settings['DOCEDIT_S3_REGION']
  $now = [DateTime]::UtcNow
  $amzDate = $now.ToString('yyyyMMddTHHmmssZ', [Globalization.CultureInfo]::InvariantCulture)
  $day = $amzDate.Substring(0, 8)
  $payloadHash = Get-Sha256Hex $Body
  $signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  $canonical = "$Method`n$Path`n`nhost:$hostHeader`nx-amz-content-sha256:$payloadHash`nx-amz-date:$amzDate`n`n$signedHeaders`n$payloadHash"
  $scope = "$day/$region/s3/aws4_request"
  $toSign = "AWS4-HMAC-SHA256`n$amzDate`n$scope`n$(Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($canonical)))"
  $k = Get-HmacSha256 ([Text.Encoding]::UTF8.GetBytes("AWS4$($Settings['DOCEDIT_S3_SECRET_KEY'])")) $day
  $k = Get-HmacSha256 $k $region
  $k = Get-HmacSha256 $k 's3'
  $k = Get-HmacSha256 $k 'aws4_request'
  $signature = [Convert]::ToHexString((Get-HmacSha256 $k $toSign)).ToLowerInvariant()
  $http = [System.Net.Http.HttpClient]::new()
  try {
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), "http://$hostHeader$Path")
    $req.Headers.TryAddWithoutValidation('x-amz-date', $amzDate) | Out-Null
    $req.Headers.TryAddWithoutValidation('x-amz-content-sha256', $payloadHash) | Out-Null
    $req.Headers.TryAddWithoutValidation('Authorization', "AWS4-HMAC-SHA256 Credential=$($Settings['DOCEDIT_S3_ACCESS_KEY'])/$scope, SignedHeaders=$signedHeaders, Signature=$signature") | Out-Null
    if ($Body.Length -gt 0) { $req.Content = [System.Net.Http.ByteArrayContent]::new($Body) }
    $res = $http.SendAsync($req).GetAwaiter().GetResult()
    $bytes = $res.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{ Status = [int]$res.StatusCode; Body = $bytes }
  } finally { $http.Dispose() }
}

function Initialize-Bucket {
  $bucket = $Settings['DOCEDIT_S3_BUCKET']
  $r = Invoke-S3 'PUT' "/$bucket"
  $text = [Text.Encoding]::UTF8.GetString($r.Body)
  if ($r.Status -ne 200 -and $text -notmatch 'BucketAlreadyOwnedByYou') {
    throw "S3: creating bucket $bucket failed with HTTP $($r.Status): $text"
  }
  $probe = [Text.Encoding]::UTF8.GetBytes("docedit test environment $([DateTime]::UtcNow.ToString('o'))")
  $put = Invoke-S3 'PUT' "/$bucket/env-check.txt" $probe
  $get = Invoke-S3 'GET' "/$bucket/env-check.txt"
  $del = Invoke-S3 'DELETE' "/$bucket/env-check.txt"
  if ($put.Status -ne 200 -or $get.Status -ne 200 -or $del.Status -ne 204 -or
      [Convert]::ToHexString($get.Body) -ne [Convert]::ToHexString($probe)) {
    throw "S3: smoke test failed (PUT $($put.Status), GET $($get.Status), DELETE $($del.Status))"
  }
}

# --- Export worker: build from its Containerfile and run one job in the sandbox, without network.

function Initialize-ExportWorker([string]$Project, $Def, [string]$Cgroups) {
  $svc = $Def['services']['export-worker']
  $image = Expand-Setting $svc['image']
  $context = [IO.Path]::GetFullPath((Join-Path $DefsDir $svc['build']['context']))
  $file = [IO.Path]::GetFullPath((Join-Path $context $svc['build']['dockerfile']))
  if (-not (Test-Path -LiteralPath $file)) {
    Write-Warning "export worker: $file does not exist; skipped"
    return 'skipped (no Containerfile)'
  }
  $t0 = Get-Date
  Invoke-Cli @('build', '--file', $file, '--tag', $image, $context) | Out-Null
  $buildSeconds = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)

  $work = Join-Path ([IO.Path]::GetTempPath()) "docedit-export-check-$PID"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    Set-Content -LiteralPath (Join-Path $work 'main.tex') -Encoding utf8NoBOM -Value @(
      '\documentclass{article}', '\begin{document}', 'Integration environment check.', '\end{document}')
    & tar -c -f (Join-Path $work 'in.tar') -C $work main.tex
    if ($LASTEXITCODE -ne 0) { throw 'export worker: tar failed' }
    $runArgs = Get-RunArguments $Project 'export-worker' $svc $Cgroups -Job
    $t1 = Get-Date
    $p = Start-Process -FilePath $Cli -ArgumentList $runArgs -NoNewWindow -Wait -PassThru `
      -RedirectStandardInput (Join-Path $work 'in.tar') -RedirectStandardOutput (Join-Path $work 'out.tar') `
      -RedirectStandardError (Join-Path $work 'err.txt')
    $jobSeconds = [math]::Round(((Get-Date) - $t1).TotalSeconds, 1)
    $listing = & tar -t -f (Join-Path $work 'out.tar') 2>$null
    if ($p.ExitCode -ne 0 -or -not ($listing -contains 'main.pdf')) {
      $err = Get-Content -LiteralPath (Join-Path $work 'err.txt') -Raw -ErrorAction SilentlyContinue
      throw "export worker: the check job failed (exit $($p.ExitCode)); outputs: $($listing -join ', '); stderr: $err"
    }
    return "image $image built in $buildSeconds s; one job without network produced main.pdf in $jobSeconds s"
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- Commands.

function Start-Environment {
  $t0 = Get-Date
  $def = Get-Definition
  $project = $def['name']
  $cgroups = Get-CgroupsMode
  $endpoints = @{
    postgres = @{ Host = $Settings['DOCEDIT_PG_HOST']; Port = [int]$Settings['DOCEDIT_PG_PORT'] }
    s3       = @{ Host = $Settings['DOCEDIT_S3_HOST']; Port = [int]$Settings['DOCEDIT_S3_PORT'] }
  }
  foreach ($service in @('postgres', 's3')) {
    $svc = $def['services'][$service]
    $name = Get-ContainerName $project $service
    $state = Get-ContainerState $name
    if ($state -ne 'running') {
      if ($state -ne 'absent') { Invoke-Cli @('rm', '--force', $name) | Out-Null }
      $ep = $endpoints[$service]
      if (Test-TcpPort $ep.Host $ep.Port) {
        throw "${service}: $($ep.Host):$($ep.Port) is already in use by something else; set another port in the environment or in infra/containers/.env"
      }
      Invoke-Cli (Get-RunArguments $project $service $svc $cgroups) | Out-Null
    }
  }
  foreach ($service in @('postgres', 's3')) {
    $ep = $endpoints[$service]
    Wait-Ready $project $service $def['services'][$service] $ep.Host $ep.Port
  }
  Initialize-Bucket
  $export = if ($NoExport) { 'skipped (-NoExport)' } else { Initialize-ExportWorker $project $def $cgroups }
  $seconds = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  Write-Host "test environment '$project' is up in $seconds s (cgroups $cgroups)"
  Write-Host "  postgres  $($endpoints.postgres.Host):$($endpoints.postgres.Port)"
  Write-Host "  s3        http://$($endpoints.s3.Host):$($endpoints.s3.Port) bucket $($Settings['DOCEDIT_S3_BUCKET'])"
  Write-Host "  export    $export"
}

function Stop-Environment {
  $project = (Get-Definition)['name']
  $names = (Invoke-Cli @('ps', '--all', '--filter', "label=org.docedit.project=$project", '--format', '{{.Names}}')).Output -split "`n" |
    Where-Object { $_.Trim() -ne '' }
  if ($names) { Invoke-Cli (@('rm', '--force', '--volumes', '--time', '2') + $names) | Out-Null }
  Write-Host "test environment '$project' is down ($(@($names).Count) containers removed)"
}

function Show-Status {
  $def = Get-Definition
  $project = $def['name']
  foreach ($service in @('postgres', 's3')) {
    $name = Get-ContainerName $project $service
    Write-Host ("{0,-10} {1}" -f $service, (Get-ContainerState $name))
  }
  $image = Expand-Setting $def['services']['export-worker']['image']
  $exists = (Invoke-Cli @('image', 'exists', $image) -AllowFailure).Code -eq 0
  Write-Host ("{0,-10} {1}" -f 'export', $(if ($exists) { "image $image present" } else { "image $image absent" }))
}

switch ($Command) {
  'up' { Start-Environment }
  'down' { Stop-Environment }
  'reset' { Stop-Environment; Start-Environment }
  'status' { Show-Status }
  'run' {
    $cmd = @($Rest | Where-Object { $_ -ne '--' })
    if ($cmd.Count -eq 0) { throw 'run: give the command to run, for example: infra/test-env.ps1 run pnpm test' }
    $code = 1
    try {
      Stop-Environment
      Start-Environment
      # Splat a variable: an inline @(...) would reach a PowerShell shim (pnpm.ps1) as one argument.
      $program = $cmd[0]
      $arguments = @($cmd | Select-Object -Skip 1)
      & $program @arguments
      $code = $LASTEXITCODE
    } finally {
      Stop-Environment
    }
    exit $code
  }
}
