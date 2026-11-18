# EXP-097: licence, maintenance and security data of the DOCX parser candidates, read from public
# registries, GitHub and the OSV database. Writes metadata.json next to this script.
# Run: pwsh -NoProfile -File docs/spikes/exp-097/collect-metadata.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$day = { param($d) if ($null -eq $d) { $null } else { ([datetime]$d).ToUniversalTime().ToString('yyyy-MM-dd') } }

function Get-Osv([string]$name, [string]$ecosystem) {
  $body = @{ package = @{ name = $name; ecosystem = $ecosystem } } | ConvertTo-Json -Depth 4
  $r = Invoke-RestMethod -Method Post -Uri 'https://api.osv.dev/v1/query' -Body $body -ContentType 'application/json'
  @($r.vulns) | Where-Object { $_ } | ForEach-Object {
    $fixed = @()
    foreach ($a in $_.affected) { foreach ($rg in $a.ranges) { foreach ($e in $rg.events) { if ($e.fixed) { $fixed += $e.fixed } } } }
    [ordered]@{
      id = $_.id
      aliases = @($_.aliases)
      published = (& $day $_.published)
      fixed = @($fixed | Select-Object -Unique)
      summary = $_.summary
    }
  }
}

function Get-Repo([string]$full) {
  $r = Invoke-RestMethod "https://api.github.com/repos/$full" -Headers @{ 'User-Agent' = 'docedit-spike' }
  $rel = $null
  try { $rel = Invoke-RestMethod "https://api.github.com/repos/$full/releases/latest" -Headers @{ 'User-Agent' = 'docedit-spike' } } catch { }
  [ordered]@{
    repo = $full
    licence = $r.license.spdx_id
    pushed = (& $day $r.pushed_at)
    archived = $r.archived
    openIssues = $r.open_issues_count
    latestRelease = if ($rel) { $rel.tag_name } else { $null }
    latestReleaseDate = if ($rel) { (& $day $rel.published_at) } else { $null }
  }
}

$out = [ordered]@{ collected = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'); candidates = [ordered]@{} }

# mammoth and its XML parser (npm)
$m = Invoke-RestMethod 'https://registry.npmjs.org/mammoth'
$mv = $m.'dist-tags'.latest
$out.candidates['mammoth'] = [ordered]@{
  runtime = 'Node.js'; registry = 'npm'; latest = $mv; latestDate = (& $day $m.time.$mv)
  licence = $m.versions.$mv.license; dependencies = @($m.versions.$mv.dependencies.PSObject.Properties.Name)
  repo = Get-Repo 'mwilliamson/mammoth.js'; advisories = @(Get-Osv 'mammoth' 'npm')
}
$x = Invoke-RestMethod 'https://registry.npmjs.org/@xmldom%2Fxmldom'
$xv = $x.'dist-tags'.latest
$out.candidates['@xmldom/xmldom'] = [ordered]@{
  runtime = 'Node.js'; registry = 'npm'; latest = $xv; latestDate = (& $day $x.time.$xv)
  licence = $x.versions.$xv.license; advisories = @(Get-Osv '@xmldom/xmldom' 'npm')
}
$p = Invoke-RestMethod 'https://registry.npmjs.org/@rgrove%2Fparse-xml'
$pv = $p.'dist-tags'.latest
$out.candidates['@rgrove/parse-xml'] = [ordered]@{
  runtime = 'Node.js'; registry = 'npm'; latest = $pv; latestDate = (& $day $p.time.$pv)
  licence = $p.versions.$pv.license; repo = Get-Repo 'rgrove/parse-xml'; advisories = @(Get-Osv '@rgrove/parse-xml' 'npm')
}

# Open XML SDK (NuGet)
$nv = (Invoke-RestMethod 'https://api.nuget.org/v3-flatcontainer/documentformat.openxml/index.json').versions
$nlatest = ($nv | Where-Object { $_ -notmatch '-' } | Select-Object -Last 1)
$out.candidates['DocumentFormat.OpenXml'] = [ordered]@{
  runtime = '.NET'; registry = 'NuGet'; latest = $nlatest; licence = 'MIT (repository licence)'
  repo = Get-Repo 'dotnet/Open-XML-SDK'; advisories = @(Get-Osv 'DocumentFormat.OpenXml' 'NuGet')
}

# docx4j and Apache POI (Maven Central)
foreach ($c in @(@('org.docx4j', 'docx4j-core', 'plutext/docx4j'), @('org.apache.poi', 'poi-ooxml', 'apache/poi'))) {
  $meta = [xml](Invoke-RestMethod "https://repo1.maven.org/maven2/$($c[0].Replace('.', '/'))/$($c[1])/maven-metadata.xml")
  $out.candidates["$($c[0]):$($c[1])"] = [ordered]@{
    runtime = 'JVM'; registry = 'Maven Central'; latest = $meta.metadata.versioning.release
    lastUpdated = $meta.metadata.versioning.lastUpdated
    repo = Get-Repo $c[2]; advisories = @(Get-Osv "$($c[0]):$($c[1])" 'Maven')
  }
}

# python-docx (PyPI)
$py = Invoke-RestMethod 'https://pypi.org/pypi/python-docx/json'
$pyv = $py.info.version
$out.candidates['python-docx'] = [ordered]@{
  runtime = 'Python'; registry = 'PyPI'; latest = $pyv
  latestDate = (& $day $py.releases.$pyv[0].upload_time); licence = $py.info.license_expression ?? $py.info.license
  repo = Get-Repo 'python-openxml/python-docx'; advisories = @(Get-Osv 'python-docx' 'PyPI')
}

# Pandoc (separate process; GPL)
$out.candidates['pandoc'] = [ordered]@{ runtime = 'Haskell binary'; repo = Get-Repo 'jgm/pandoc'; advisories = @() }

$out | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $here 'metadata.json') -Encoding utf8
"written"
