#Requires -Version 7.2
<#
.SYNOPSIS
  The network-policy test of webhook delivery (BE-056 criterion 4; lane V-BE-043-056): the
  dispatcher's only route out is the egress proxy.

.DESCRIPTION
  Builds three containers on Podman, all named docedit-v-be-043-056-*:
    outside   on a normal network: a stand-in for any host outside (no published ports)
    proxy     on an internal network (no route out) and on the normal network: the product's
              EgressProxy (services/document-service/src/control-plane/webhook-egress.ts),
              mounted read-only
    dispatcher a probe on the internal network only
  The probe checks that it cannot connect directly to the outside host or to a public address,
  that the proxy answers, and that the proxy refuses private, metadata and loopback targets.
  Exit code 0 only when every check holds. The containers and networks are removed afterwards.

  Limit: this proves the policy as the repository defines it (the networks here), not the
  production network of a deployment, which is infrastructure outside this repository.

  DOCEDIT_CONTAINER_CLI overrides the container CLI (default podman). Image: node:24.21.0-slim,
  which must be present locally (--pull=never).

.EXAMPLE
  pwsh -NoProfile -File infra/webhook-egress-policy.ps1
#>
[CmdletBinding()]
param(
  # Negative control (SEC-020 criterion 5): the dispatcher probe is put on the outside network
  # instead of the internal one. The probe must then FAIL its direct-connection check, which shows
  # that the probe can tell a leaking network from a closed one. Exit code 0 only when it does.
  [switch]$NegativeControl
)

$ErrorActionPreference = 'Stop'
$Cli = if ($env:DOCEDIT_CONTAINER_CLI) { $env:DOCEDIT_CONTAINER_CLI } else { 'podman' }
$Image = 'docker.io/library/node:24.21.0-slim'
# DOCEDIT_EGRESS_PREFIX renames the containers and networks (a lane gives its own, ending -w8).
$Prefix = if ($env:DOCEDIT_EGRESS_PREFIX) { $env:DOCEDIT_EGRESS_PREFIX } else { 'docedit-v-be-043-056' }
$IntNet = "$Prefix-int"
$ExtNet = "$Prefix-ext"
$Names = @("$Prefix-outside", "$Prefix-proxy", "$Prefix-dispatcher")
$Root = Split-Path -Parent $PSScriptRoot
$Infra = (Join-Path $PSScriptRoot 'containers/webhook-egress') -replace '\\', '/'
$Cp = (Join-Path $Root 'services/document-service/src/control-plane') -replace '\\', '/'

function Invoke-Cli([string[]]$Arguments, [switch]$AllowFailure) {
  $out = & $Cli @Arguments 2>&1
  $code = $LASTEXITCODE
  $text = ($out | ForEach-Object { "$_" }) -join "`n"
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "$Cli $($Arguments -join ' ') failed with exit code ${code}:`n$text"
  }
  return [pscustomobject]@{ Code = $code; Output = $text }
}

function Get-Cgroups {
  if ($env:DOCEDIT_CONTAINER_CGROUPS) { return $env:DOCEDIT_CONTAINER_CGROUPS }
  $remote = (Invoke-Cli @('info', '--format', '{{.Host.ServiceIsRemote}}') -AllowFailure).Output.Trim()
  if ($remote -eq 'true') { return 'disabled' }
  return 'enabled'
}

function Remove-Lab {
  foreach ($n in $Names) { Invoke-Cli @('rm', '-f', $n) -AllowFailure | Out-Null }
  foreach ($net in @($IntNet, $ExtNet)) { Invoke-Cli @('network', 'rm', '-f', $net) -AllowFailure | Out-Null }
}

function Get-Ip([string]$Container, [string]$Network) {
  $json = (Invoke-Cli @('inspect', $Container)).Output | ConvertFrom-Json
  $ip = $json[0].NetworkSettings.Networks.$Network.IPAddress
  if ([string]::IsNullOrEmpty($ip)) { throw "no address for $Container on $Network" }
  return $ip
}

$cg = Get-Cgroups
$cgArg = if ($cg -eq 'disabled') { @('--cgroups=disabled') } else { @() }
$exit = 1
try {
  Remove-Lab
  Invoke-Cli @('network', 'create', $ExtNet) | Out-Null
  Invoke-Cli @('network', 'create', '--internal', $IntNet) | Out-Null

  Invoke-Cli (@('run', '-d', '--pull=never', '--name', "$Prefix-outside", '--network', $ExtNet) + $cgArg +
    @('-v', "$Infra/outside.mjs:/srv/outside.mjs:ro", $Image, 'node', '/srv/outside.mjs')) | Out-Null

  Invoke-Cli (@('run', '-d', '--pull=never', '--name', "$Prefix-proxy", '--network', $IntNet) + $cgArg +
    @('-v', "$Infra/proxy.mjs:/srv/proxy.mjs:ro", '-v', "${Cp}:/srv/cp:ro", $Image, 'node', '/srv/proxy.mjs')) | Out-Null
  Invoke-Cli @('network', 'connect', $ExtNet, "$Prefix-proxy") | Out-Null

  $outsideIp = Get-Ip "$Prefix-outside" $ExtNet
  $proxyIp = Get-Ip "$Prefix-proxy" $IntNet
  Write-Host "outside $outsideIp on $ExtNet; proxy $proxyIp on $IntNet (and on $ExtNet); dispatcher on $IntNet only; cgroups $cg"

  if ($NegativeControl) {
    $proxyExtIp = Get-Ip "$Prefix-proxy" $ExtNet
    $probe = Invoke-Cli (@('run', '--rm', '--pull=never', '--name', "$Prefix-dispatcher", '--network', $ExtNet) + $cgArg +
      @('-e', "PROXY_HOST=$proxyExtIp", '-e', 'PROXY_PORT=3128', '-e', "OUTSIDE_IP=$outsideIp", '-e', 'OUTSIDE_PORT=8080',
        '-v', "$Infra/probe.mjs:/srv/probe.mjs:ro", $Image, 'node', '/srv/probe.mjs')) -AllowFailure
    Write-Host $probe.Output
    $leaked = $probe.Output -match 'FAIL no direct connection to the outside host'
    if ($probe.Code -ne 0 -and $leaked) { $exit = 0; Write-Host 'negative control: the probe detects a dispatcher that can reach the outside host' }
    else { $exit = 1; Write-Host 'negative control: the probe did NOT detect the leak' }
  }
  else {
    $probe = Invoke-Cli (@('run', '--rm', '--pull=never', '--name', "$Prefix-dispatcher", '--network', $IntNet) + $cgArg +
      @('-e', "PROXY_HOST=$proxyIp", '-e', 'PROXY_PORT=3128', '-e', "OUTSIDE_IP=$outsideIp", '-e', 'OUTSIDE_PORT=8080',
        '-v', "$Infra/probe.mjs:/srv/probe.mjs:ro", $Image, 'node', '/srv/probe.mjs')) -AllowFailure
    Write-Host $probe.Output
    $exit = $probe.Code
    if ($exit -eq 0) { Write-Host 'webhook egress policy: every check holds' } else { Write-Host "webhook egress policy: a check failed (exit $exit)" }
  }
}
finally {
  Remove-Lab
}
exit $exit
