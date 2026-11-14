# Regenerates BACKLOG.md from the epic files; -Summary prints the counts table used in README section 4.
# Usage: pwsh docs/stories/tools/build-backlog.ps1 [-Summary]
param(
  [string]$Dir = (Join-Path $PSScriptRoot ".."),
  [string]$Out = (Join-Path $PSScriptRoot "..\BACKLOG.md"),
  [switch]$Summary
)
$prefixes = 'FND|SPK|FE|CDM|SYN|PRO|BE|PRM|HIS|EXP|SEC|FRW|UX|WASM'
$epicOrder = @('FND','SPK','CDM','SYN','PRM','PRO','BE','SEC','FE','UX','HIS','EXP','FRW','WASM')
$phaseOrder = @('0','1a','1b','2','3','4','cond')
$prioOrder = @('must','should','could')
$phaseTitle = @{ '0'='Phase 0: decisions, spikes and notes'; '1a'='Phase 1a: minimum demo'; '1b'='Phase 1b: first usable release';
  '2'='Phase 2: review, history, workflow'; '3'='Phase 3: pages (gated on SPK-013)'; '4'='Phase 4: scale, interoperability, reach';
  'cond'='Conditional: only if a decision or spike goes a certain way (see each story''s Notes)' }

function Anchor([string]$h) {
  $a = $h.ToLower() -replace '[^\p{L}\p{N} _-]', ''
  return ($a -replace ' ', '-')
}

$stories = @()
foreach ($f in Get-ChildItem $Dir -Filter *.md | Where-Object { $_.Name -notin @('README.md','BACKLOG.md') }) {
  $lines = Get-Content $f.FullName -Encoding UTF8
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^###\s+(($prefixes)-\d{3})\s+(.+)$") {
      $id = $Matches[1]; $ep = $Matches[2]; $title = $Matches[3].Trim()
      $heading = "$id $title"
      for ($j = $i + 1; $j -lt [Math]::Min($i + 8, $lines.Count); $j++) {
        if ($lines[$j] -match '^\|\s*(story|enabler|spike|decision)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|') {
          $stories += [pscustomobject]@{ Id=$id; Epic=$ep; Title=$title; File=$f.Name; Anchor=(Anchor $heading);
            Type=$Matches[1]; Phase=$Matches[2]; Size=$Matches[3]; Priority=$Matches[4]; Persona=$Matches[5] }
          break
        }
      }
    }
  }
}

if ($Summary) {
  "| Epic | " + ($phaseOrder -join ' | ') + " | Total |"
  "|---|" + (($phaseOrder | ForEach-Object { '---:' }) -join '|') + "|---:|"
  foreach ($e in $epicOrder) {
    $row = foreach ($p in $phaseOrder) { $c = @($stories | Where-Object { $_.Epic -eq $e -and $_.Phase -eq $p }).Count; if ($c) { $c } else { '' } }
    "| $e | " + ($row -join ' | ') + " | " + @($stories | Where-Object { $_.Epic -eq $e }).Count + " |"
  }
  $tot = foreach ($p in $phaseOrder) { @($stories | Where-Object { $_.Phase -eq $p }).Count }
  "| **All** | " + ($tot -join ' | ') + " | **" + $stories.Count + "** |"
  ""
  "Types: " + (($stories | Group-Object Type | Sort-Object Name | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', ')
  foreach ($p in $phaseOrder) {
    $g = $stories | Where-Object { $_.Phase -eq $p }
    "Phase $p sizes: " + (($g | Group-Object Size | Sort-Object Name | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', ') + "; must " + @($g | Where-Object Priority -eq 'must').Count
  }
  return
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('# Backlog by phase')
[void]$sb.AppendLine('')
[void]$sb.AppendLine("Generated on $(Get-Date -Format yyyy-MM-dd) from the epic files in this folder; regenerate it whenever a story's fields change. $($stories.Count) stories. Within a phase, stories are ordered by priority, then by epic in build order (foundations, decisions and spikes, model, sync, permissions, protocol, backend, security, frontend, shell, history, export, fields and workflow, WebAssembly). Order within a phase is not a dependency order: each story's **Depends on** line is.")
[void]$sb.AppendLine('')
foreach ($p in $phaseOrder) {
  $g = @($stories | Where-Object { $_.Phase -eq $p })
  if (-not $g.Count) { continue }
  [void]$sb.AppendLine("## $($phaseTitle[$p]) ($($g.Count))")
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| Story | Title | Type | Size | Priority |')
  [void]$sb.AppendLine('|---|---|---|---|---|')
  $sorted = $g | Sort-Object @{e={ $prioOrder.IndexOf($_.Priority) }}, @{e={ $epicOrder.IndexOf($_.Epic) }}, Id
  foreach ($s in $sorted) {
    $t = $s.Title -replace '\|', '\|'
    [void]$sb.AppendLine("| [$($s.Id)]($($s.File)#$($s.Anchor)) | $t | $($s.Type) | $($s.Size) | $($s.Priority) |")
  }
  [void]$sb.AppendLine('')
}
[System.IO.File]::WriteAllText($Out, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
"Wrote $Out with $($stories.Count) stories"
