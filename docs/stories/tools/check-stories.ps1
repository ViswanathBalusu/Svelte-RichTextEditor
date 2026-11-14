# Checks every epic file: field values, criteria counts, duplicate IDs, missing dependencies, unresolved placeholders.
# Usage: pwsh docs/stories/tools/check-stories.ps1 [-Only FE]
param(
  [string]$Dir = (Join-Path $PSScriptRoot ".."),
  [switch]$Backlog,
  [string]$Only = ""
)

$validPhase    = @('0','1a','1b','2','3','4','cond')
$validSize     = @('S','M','L')
$validPriority = @('must','should','could')
$validType     = @('story','enabler','spike','decision')
$validPersona  = @('Author','Owner','Editor','Suggester','Commenter','Viewer','Participant','Relying party','Integrating developer','Operator','Tenant administrator','Maintainer','Project owner')
$prefixes      = 'FND|SPK|FE|CDM|SYN|PRO|BE|PRM|HIS|EXP|SEC|FRW|UX|WASM'

$files = Get-ChildItem $Dir -Filter *.md | Where-Object { $_.Name -notin @('README.md','BACKLOG.md') }
if ($Only) { $files = $files | Where-Object { $_.Name -like "$Only*" } }

$stories = New-Object System.Collections.Generic.List[object]
$problems = New-Object System.Collections.Generic.List[string]
$placeholders = @{}

foreach ($f in $files) {
  $lines = Get-Content $f.FullName -Encoding UTF8
  $current = $null
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    foreach ($m in [regex]::Matches($line, "\[($prefixes):[^\]]+\]")) {
      $key = "$($f.Name) :: $($m.Value)"
      if (-not $placeholders.ContainsKey($key)) { $placeholders[$key] = 0 }
      $placeholders[$key]++
    }
    if ($line -match '^#{1,3}\s' -and $current) { $stories.Add($current); $current = $null }
    if ($line -match "^###\s+(($prefixes)-\d{3})\s+(.+)$") {
      $current = [pscustomobject]@{ Id=$Matches[1]; Epic=$Matches[2]; Title=$Matches[3].Trim(); File=$f.Name;
        Type=''; Phase=''; Size=''; Priority=''; Persona=''; Deps=''; ACs=0 }
      continue
    }
    if ($current) {
      if (-not $current.Type -and $line -match '^\|\s*(story|enabler|spike|decision)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|') {
        $current.Type=$Matches[1]; $current.Phase=$Matches[2]; $current.Size=$Matches[3]; $current.Priority=$Matches[4]; $current.Persona=$Matches[5]
      }
      if (-not $current.Deps -and $line -match 'Depends on:\*\*\s*(.+)$') { $current.Deps = $Matches[1] }
      if ($line -match '^\s*-\s\[[ xX]\]') { $current.ACs++ }
    }
  }
  if ($current) { $stories.Add($current) }
}

$ids = @{}
foreach ($s in $stories) {
  if ($ids.ContainsKey($s.Id)) { $problems.Add("DUPLICATE id $($s.Id) in $($s.File) and $($ids[$s.Id])") } else { $ids[$s.Id] = $s.File }
  if (-not $s.Type) { $problems.Add("NO FIELD TABLE $($s.Id)"); continue }
  if ($validPhase -notcontains $s.Phase)       { $problems.Add("BAD phase '$($s.Phase)' $($s.Id)") }
  if ($validSize -notcontains $s.Size)         { $problems.Add("BAD size '$($s.Size)' $($s.Id)") }
  if ($validPriority -notcontains $s.Priority) { $problems.Add("BAD priority '$($s.Priority)' $($s.Id)") }
  if ($validPersona -notcontains $s.Persona)   { $problems.Add("BAD persona '$($s.Persona)' $($s.Id)") }
  if ($s.ACs -lt 3 -or $s.ACs -gt 8)           { $problems.Add("AC count $($s.ACs) $($s.Id)") }
}
foreach ($s in $stories) {
  foreach ($m in [regex]::Matches($s.Deps, "\b($prefixes)-\d{3}\b")) {
    if (-not $ids.ContainsKey($m.Value)) { $problems.Add("MISSING dependency $($m.Value) referenced by $($s.Id)") }
  }
}

if ($Backlog) {
  $order = @('0','1a','1b','2','3','4','cond')
  foreach ($p in $order) {
    $group = $stories | Where-Object { $_.Phase -eq $p }
    if (-not $group) { continue }
    "### Phase $p ($(@($group).Count))"
    ""
    "| Story | Title | Type | Size | Priority |"
    "|---|---|---|---|---|"
    foreach ($s in ($group | Sort-Object @{e={ @('must','should','could').IndexOf($_.Priority) }}, Epic, Id)) {
      "| $($s.Id) | $($s.Title) | $($s.Type) | $($s.Size) | $($s.Priority) |"
    }
    ""
  }
  return
}

"== Stories: $($stories.Count)"
$stories | Group-Object Epic | Sort-Object Name | ForEach-Object {
  $byPhase = ($_.Group | Group-Object Phase | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' '
  "{0,-5} {1,4}   {2}" -f $_.Name, $_.Count, $byPhase
}
""
"== By type"
$stories | Group-Object Type | ForEach-Object { "{0,-9} {1}" -f $_.Name, $_.Count }
""
"== Problems ($($problems.Count))"
$problems | ForEach-Object { $_ }
""
"== Unresolved placeholders ($($placeholders.Count))"
$placeholders.Keys | Sort-Object | ForEach-Object { $_ }
