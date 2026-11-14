# Reports dependencies on a later phase and dependency cycles across all epic files.
# Usage: pwsh docs/stories/tools/check-dependencies.ps1
param([string]$Dir = (Join-Path $PSScriptRoot ".."))
$prefixes = 'FND|SPK|FE|CDM|SYN|PRO|BE|PRM|HIS|EXP|SEC|FRW|UX|WASM'
$rank = @{ '0'=0; '1a'=1; '1b'=2; '2'=3; '3'=4; '4'=5; 'cond'=9 }
$phase = @{}; $deps = @{}
foreach ($f in Get-ChildItem $Dir -Filter *.md | Where-Object { $_.Name -notin @('README.md','BACKLOG.md') }) {
  $lines = Get-Content $f.FullName -Encoding UTF8
  $cur = $null
  foreach ($line in $lines) {
    if ($line -match "^###\s+(($prefixes)-\d{3})\s") { $cur = $Matches[1]; $deps[$cur] = @(); continue }
    if ($line -match '^#{1,2}\s') { $cur = $null; continue }
    if (-not $cur) { continue }
    if (-not $phase.ContainsKey($cur) -and $line -match '^\|\s*(story|enabler|spike|decision)\s*\|\s*([^|]+?)\s*\|') { $phase[$cur] = $Matches[2] }
    if ($line -match 'Depends on:\*\*\s*(.+)$') {
      $deps[$cur] = @([regex]::Matches($Matches[1], "\b($prefixes)-\d{3}\b") | ForEach-Object { $_.Value } | Where-Object { $_ -ne $cur } | Select-Object -Unique)
    }
  }
}
# later-phase dependencies (cond excluded on both sides)
$late = foreach ($s in $deps.Keys) {
  foreach ($d in $deps[$s]) {
    if (-not $phase.ContainsKey($d)) { continue }
    $ps = $rank[$phase[$s]]; $pd = $rank[$phase[$d]]
    if ($ps -lt 9 -and $pd -lt 9 -and $pd -gt $ps) { "{0} [{1}] depends on {2} [{3}]" -f $s, $phase[$s], $d, $phase[$d] }
  }
}
"== Dependencies on a later phase: $(@($late).Count)"
$late | Sort-Object
# cycles: repeatedly remove stories whose remaining dependencies are all removed (Kahn);
# whatever is left is on a cycle or depends on one
$remaining = @{}
foreach ($s in $deps.Keys) { $remaining[$s] = [System.Collections.Generic.HashSet[string]]::new([string[]]@($deps[$s] | Where-Object { $deps.ContainsKey($_) })) }
$changed = $true
while ($changed) {
  $changed = $false
  $free = @($remaining.Keys | Where-Object { $remaining[$_].Count -eq 0 })
  foreach ($f in $free) { $remaining.Remove($f); $changed = $true }
  if ($changed) { foreach ($s in @($remaining.Keys)) { foreach ($f in $free) { [void]$remaining[$s].Remove($f) } } }
}
"== Stories on or behind a dependency cycle: $($remaining.Count)"
$pairs = foreach ($s in $remaining.Keys) { foreach ($d in $remaining[$s]) { if ($remaining.ContainsKey($d) -and $remaining[$d].Contains($s) -and $s -lt $d) { "$s <-> $d" } } }
"== Mutual pairs: $(@($pairs).Count)"
$pairs
if ($remaining.Count) {
  # walk remaining edges from several starts to show concrete cycles
  $seen = @{}
  :outer foreach ($start in ($remaining.Keys | Sort-Object)) {
    foreach ($first in ($remaining[$start] | Sort-Object)) {
      $path = New-Object System.Collections.Generic.List[string]; $path.Add($start); $n = $first
      while (-not $path.Contains($n)) { $path.Add($n); $n = @($remaining[$n] | Sort-Object)[0] }
      $cyc = $path.GetRange($path.IndexOf($n), $path.Count - $path.IndexOf($n))
      $key = (@($cyc) | Sort-Object) -join ','
      if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; "CYCLE: " + ((@($cyc) + $n) -join ' -> ') }
      if ($seen.Count -ge 60) { break outer }
    }
  }
}
