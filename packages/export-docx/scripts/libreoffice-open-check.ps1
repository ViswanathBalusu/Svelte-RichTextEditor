# Opens every .docx under a directory in LibreOffice (headless) and records whether LibreOffice
# loaded it (SPK-028: "no repair prompt", LibreOffice half). PowerShell 7:
#   pwsh -NoProfile -File libreoffice-open-check.ps1 -Dir <dir> -Result <file.json> [-Soffice <path>]
#
# How: soffice converts each file to PDF in a scratch folder, with its own user profile so that
# nothing in the person's LibreOffice settings is read or changed. Files go in batches of
# $BatchSize. A file that LibreOffice cannot load prints "source file could not be loaded" and
# writes no PDF; a file that loads writes a non-empty PDF. LibreOffice has no repair dialog for
# .docx in headless mode: it either loads the file or refuses it, so "loaded" is the measurable
# form of "no repair prompt" here. A file LibreOffice repairs silently counts as loaded.
# -Calibrate also converts two damaged copies of the first file (malformed XML in document.xml;
# a file that is not a package) and requires both to fail, so the check is shown to see failures.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Result,
  [string]$Soffice = 'C:\Program Files\LibreOffice\program\soffice.exe',
  [int]$BatchSize = 25,
  [int]$BatchSeconds = 600,
  [switch]$Calibrate
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Soffice)) { throw "soffice not found at $Soffice" }
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("lo-check-w4-" + [guid]::NewGuid().ToString('N'))
$profileDir = Join-Path $scratch 'profile'
New-Item -ItemType Directory -Force $scratch, $profileDir | Out-Null
$profileUrl = 'file:///' + ($profileDir -replace '\\', '/')

# `soffice --version` starts a program that does not exit here, so the version comes from the file.
$version = 'LibreOffice ' + (Get-Item $Soffice).VersionInfo.ProductVersion
$files = @(Get-ChildItem -LiteralPath $Dir -Recurse -Filter *.docx | Sort-Object FullName)
$results = [System.Collections.Generic.List[object]]::new()

function Convert-Batch([string[]]$paths, [string]$label) {
  # Copies to a flat folder with unique names so equal base names in different folders do not clash.
  $in = Join-Path $scratch "in-$label"
  $out = Join-Path $scratch "out-$label"
  New-Item -ItemType Directory -Force $in, $out | Out-Null
  $map = @{}
  $i = 0
  foreach ($p in $paths) {
    $name = ('{0:D4}.docx' -f $i++)
    Copy-Item -LiteralPath $p -Destination (Join-Path $in $name)
    $map[$name] = $p
  }
  $cli = @("-env:UserInstallation=$profileUrl", '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', $out) + @(Get-ChildItem $in -Filter *.docx | ForEach-Object FullName)
  $psi = [Diagnostics.ProcessStartInfo]::new($Soffice)
  foreach ($a in $cli) { $psi.ArgumentList.Add($a) }
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $proc = [Diagnostics.Process]::Start($psi)
  $so = $proc.StandardOutput.ReadToEndAsync(); $se = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit($BatchSeconds * 1000)) { $proc.Kill($true); $timedOut = $true } else { $timedOut = $false }
  $log = $so.Result + $se.Result
  foreach ($kv in $map.GetEnumerator()) {
    $pdf = Join-Path $out ($kv.Key -replace '\.docx$', '.pdf')
    $ok = (Test-Path $pdf) -and ((Get-Item $pdf).Length -gt 0)
    [pscustomobject]@{ file = $kv.Value; loaded = $ok; timedOut = $timedOut }
  }
  Remove-Item -Recurse -Force $in, $out -ErrorAction SilentlyContinue
}

$calibration = $null
if ($Calibrate -and $files.Count -gt 0) {
  $dmg = Join-Path $scratch 'damaged'
  New-Item -ItemType Directory -Force $dmg | Out-Null
  $src = $files[0].FullName
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $bad1 = Join-Path $dmg 'malformed-xml.docx'
  Copy-Item -LiteralPath $src $bad1
  $zip = [IO.Compression.ZipFile]::Open($bad1, 'Update')
  $e = $zip.GetEntry('word/document.xml'); $e.Delete()
  $n = $zip.CreateEntry('word/document.xml')
  $w = [IO.StreamWriter]::new($n.Open()); $w.Write('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>broken'); $w.Dispose()
  $zip.Dispose()
  $bad2 = Join-Path $dmg 'not-a-package.docx'
  [IO.File]::WriteAllBytes($bad2, [byte[]](1..200 | ForEach-Object { $_ % 251 }))
  $calibration = @(Convert-Batch @($bad1, $bad2, $src) 'cal')
}

$all = @()
for ($i = 0; $i -lt $files.Count; $i += $BatchSize) {
  $slice = $files[$i..([Math]::Min($i + $BatchSize, $files.Count) - 1)]
  $all += @(Convert-Batch ($slice | ForEach-Object FullName) ("b$i"))
  Write-Host ("{0}/{1}" -f $all.Count, $files.Count)
}
$rootFull = (Resolve-Path $Dir).Path
$rows = $all | ForEach-Object { [pscustomobject]@{ file = $_.file.Substring($rootFull.Length).TrimStart('\'); loaded = $_.loaded; timedOut = $_.timedOut } }
$summary = [ordered]@{
  libreoffice = $version
  machine = $env:COMPUTERNAME
  at = (Get-Date).ToString('o')
  total = $rows.Count
  loaded = @($rows | Where-Object loaded).Count
  failed = @($rows | Where-Object { -not $_.loaded } | ForEach-Object file)
  calibration = if ($calibration) { $calibration | ForEach-Object { [pscustomobject]@{ file = Split-Path $_.file -Leaf; loaded = $_.loaded } } } else { $null }
}
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Result -Encoding utf8
Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
Write-Host ("{0} of {1} loaded by {2}" -f $summary.loaded, $summary.total, $version)
if ($summary.failed.Count -gt 0) { Write-Host ("failed: " + ($summary.failed -join ', ')) }
