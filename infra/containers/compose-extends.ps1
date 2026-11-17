<#
.SYNOPSIS
  Resolves `extends` in a compose definition, for the scripts that start a compose file's
  services with `podman run` (infra/test-env.ps1, apps/reference-host/scripts/stack.ps1).

.DESCRIPTION
  Dot-source this file, then call Read-ComposeDefinition with the path of a compose file in JSON.
  A service with `"extends": { "file": "...", "service": "..." }` takes the named service of that
  file (a path relative to the extending file) and lays its own members over it, by Compose's
  rules: mappings are merged key by key, `command`, `entrypoint` and a health check's `test` are
  replaced, other lists are joined with the extended service's items first, and a scalar is
  replaced. FND-010 criterion 2: the shared definitions are in infra/containers/compose.base.json.
#>

function Merge-ComposeValue($Base, $Local, [string]$Key) {
  if ($Base -is [System.Collections.IDictionary] -and $Local -is [System.Collections.IDictionary]) {
    $out = [ordered]@{}
    foreach ($k in $Base.Keys) { $out[$k] = $Base[$k] }
    foreach ($k in $Local.Keys) {
      if ($out.Contains($k)) { $out[$k] = Merge-ComposeValue $out[$k] $Local[$k] $k }
      else { $out[$k] = $Local[$k] }
    }
    return $out
  }
  $replaced = @('command', 'entrypoint', 'test')
  if ($Base -is [System.Collections.IList] -and $Local -is [System.Collections.IList] -and $replaced -notcontains $Key) {
    return , @(@($Base) + @($Local))
  }
  return , $Local
}

function Read-ComposeDefinition([string]$Path, [string[]]$Seen = @()) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($Seen -contains $full) { throw "compose: `extends` loops through $full" }
  $def = Get-Content -LiteralPath $full -Raw | ConvertFrom-Json -AsHashtable
  $services = $def['services']
  foreach ($name in @($services.Keys)) {
    $svc = $services[$name]
    if (-not ($svc.Keys -contains 'extends')) { continue }
    $ext = $svc['extends']
    $baseFile = Join-Path (Split-Path -Parent $full) $ext['file']
    if (-not (Test-Path -LiteralPath $baseFile)) { throw "compose: service $name of $full extends $baseFile, which does not exist" }
    $baseDef = Read-ComposeDefinition $baseFile ($Seen + $full)
    if (-not ($baseDef['services'].Keys -contains $ext['service'])) {
      throw "compose: service $name of $full extends $($ext['service']), which $baseFile does not define"
    }
    $local = [ordered]@{}
    foreach ($k in $svc.Keys) { if ($k -ne 'extends') { $local[$k] = $svc[$k] } }
    $services[$name] = Merge-ComposeValue $baseDef['services'][$ext['service']] $local ''
  }
  return $def
}
