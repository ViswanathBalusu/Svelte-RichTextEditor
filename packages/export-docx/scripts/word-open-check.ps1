# Opens every .docx under a directory in Microsoft Word and records whether Word opened it without
# a prompt (SPK-028: "no repair prompt"). Windows PowerShell 5.1:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File word-open-check.ps1 -Dir <dir> -Result <file.json>
#
# How: a background runspace owns an invisible Word with all alerts on and opens the files one by
# one, read-only, without repair and without adding them to the recent list. A file Word wants to
# repair (or cannot open) makes Word show a prompt, which blocks Documents.Open. The main thread
# watches that Word process for a visible prompt window, records its text (UI Automation), closes
# it (WM_CLOSE, as its close button does) and lets the run go on. Nothing is saved and no Word
# setting is changed. Calibrated on damaged copies of a corpus file (S11 report §8). If a run is
# interrupted and leaves an invisible Word behind, word-dismiss-prompt.ps1 closes its prompt and
# word-quit-instance.ps1 quits it through COM.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Result,
  [int]$PerFileSeconds = 60
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class S11Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static List<IntPtr> Prompts(uint pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      var k = c.ToString();
      if (k == "NUIDialog" || k == "#32770") r.Add(h);
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@

function Prompt-Text([IntPtr]$h) {
  try {
    $ae = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $all = $ae.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $names = foreach ($e in $all) { $n = $e.Current.Name; if ($n -and $n.Length -gt 3) { $n } }
    return (($names | Select-Object -Unique) -join ' | ')
  } catch { return '(text not readable)' }
}

$root = (Resolve-Path $Dir).Path
$files = @(Get-ChildItem -Path $root -Recurse -Filter *.docx | Sort-Object FullName | ForEach-Object { $_.FullName })
$state = [hashtable]::Synchronized(@{ pid = 0; current = $null; started = $null; done = $false; version = ''; results = (New-Object System.Collections.ArrayList) })

$ps = [powershell]::Create()
[void]$ps.AddScript({
  param($files, $state)
  $missing = [System.Reflection.Missing]::Value
  $before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object Id)
  $word = New-Object -ComObject Word.Application
  try {
    $word.Visible = $false
    $word.DisplayAlerts = -1
    $state.version = "$($word.Version) build $($word.Build)"
    $state.pid = @(Get-Process WINWORD | Where-Object { $before -notcontains $_.Id } | Sort-Object StartTime -Descending | ForEach-Object Id)[0]
    foreach ($f in $files) {
      $state.current = $f
      $state.started = Get-Date
      $row = [ordered]@{ file = $f; opened = $false; error = $null; paragraphs = $null }
      try {
        $doc = $word.Documents.Open($f, $false, $true, $false, '', '', $false, '', '', 0, $missing, $false, $false, $missing, $true)
        $row.opened = $true
        $row.paragraphs = $doc.Paragraphs.Count
        $doc.Saved = $true
        $doc.Close()
      } catch { $row.error = $_.Exception.Message }
      [void]$state.results.Add([pscustomobject]$row)
    }
  } finally {
    $state.current = $null
    $word.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    $state.done = $true
  }
}).AddArgument($files).AddArgument($state)
$async = $ps.BeginInvoke()

$prompts = @{}
$hung = $null
while (-not $state.done) {
  Start-Sleep -Milliseconds 250
  if ($state.pid) {
    foreach ($h in [S11Win]::Prompts([uint32]$state.pid)) {
      $f = $state.current
      $txt = Prompt-Text $h
      if ($f) { $prompts[$f] = @($prompts[$f]) + $txt | Where-Object { $_ } }
      [void][S11Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
  }
  if ($state.started -and $state.current -and ((Get-Date) - $state.started).TotalSeconds -gt $PerFileSeconds) { $hung = $state.current; break }
}
if (-not $hung) { [void]$ps.EndInvoke($async) }

$rows = foreach ($r in $state.results) {
  $rel = $r.file.Substring($root.Length).TrimStart('\')
  $p = $prompts[$r.file]
  [pscustomobject]@{ file = $rel; opened = $r.opened; prompt = [bool]$p; promptText = if ($p) { ($p -join ' || ') } else { $null }; error = $r.error; paragraphs = $r.paragraphs; clean = ($r.opened -and -not $p) }
}
$summary = [pscustomobject]@{ word = $state.version; checked = (Get-Date -Format o); hung = $hung; files = @($rows) }
$summary | ConvertTo-Json -Depth 4 | Set-Content -Path $Result -Encoding UTF8
$clean = @($rows | Where-Object { $_.clean }).Count
"Word $($state.version): $($rows.Count) files checked, $clean opened without a prompt" + $(if ($hung) { "; stopped: Word did not return for $hung" } else { '' })
