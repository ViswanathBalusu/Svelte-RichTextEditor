# EXP-090 criterion 2: reads the formatting Word resolves for each character of a .docx.
#
# Usage (Windows PowerShell 5.1 or PowerShell 7 with Word installed):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File read-word-formatting.ps1 -Docx <file.docx> -Out <file.json>
#
# How: Word opens the file read-only, invisible, with alerts off, and no file is saved and no
# setting is changed. For each paragraph it walks the characters and reads the effective
# (resolved) character formatting of each one: Word's own cascade, not the file's XML. Consecutive
# characters with the same formatting are written as one run. Word is then quit.
param(
  [Parameter(Mandatory = $true)][string]$Docx,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$full = (Resolve-Path $Docx).Path
$word = New-Object -ComObject Word.Application
$paras = New-Object System.Collections.ArrayList
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
  $doc = $word.Documents.Open($full, $false, $true, $false)
  try {
    $n = $doc.Paragraphs.Count
    for ($i = 1; $i -le $n; $i++) {
      $pr = $doc.Paragraphs.Item($i).Range
      $runs = New-Object System.Collections.ArrayList
      $curKey = $null
      $buf = New-Object System.Text.StringBuilder
      $curFont = $null
      $cc = $pr.Characters.Count
      for ($k = 1; $k -le $cc; $k++) {
        $c = $pr.Characters.Item($k)
        $f = $c.Font
        $color = [int]$f.Color
        $colorHex = $null
        if ($color -ne -16777216) {
          $b = ($color -shr 16) -band 0xFF
          $g = ($color -shr 8) -band 0xFF
          $rr = $color -band 0xFF
          $colorHex = ('{0:X2}{1:X2}{2:X2}' -f $rr, $g, $b)
        }
        $key = '{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}' -f $f.Name, $f.Size, $f.Bold, $f.Italic, $f.Underline, $f.StrikeThrough, $f.SmallCaps, $f.AllCaps, $colorHex
        if ($key -ne $curKey -and $curKey -ne $null) {
          [void]$runs.Add([ordered]@{ text = $buf.ToString(); font = $curFont })
          $buf = New-Object System.Text.StringBuilder
        }
        if ($key -ne $curKey) {
          $curKey = $key
          $curFont = [ordered]@{
            fontName = [string]$f.Name
            fontSize = [double]$f.Size
            bold = [bool]($f.Bold -ne 0)
            italic = [bool]($f.Italic -ne 0)
            underline = [bool]($f.Underline -ne 0)
            strike = [bool]($f.StrikeThrough -ne 0)
            smallCaps = [bool]($f.SmallCaps -ne 0)
            allCaps = [bool]($f.AllCaps -ne 0)
            colorHex = $colorHex
          }
        }
        [void]$buf.Append($c.Text)
      }
      if ($curKey -ne $null) {
        [void]$runs.Add([ordered]@{ text = $buf.ToString(); font = $curFont })
      }
      [void]$paras.Add([ordered]@{ runs = $runs })
    }
  } finally {
    $doc.Close([ref]0)
  }
} finally {
  $word.Quit([ref]0)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
ConvertTo-Json -InputObject @($paras) -Depth 6 | Set-Content -Path $Out -Encoding UTF8
"paragraphs: $($paras.Count)"
