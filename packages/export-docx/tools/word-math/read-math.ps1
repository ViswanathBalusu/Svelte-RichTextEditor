# EXP-096 criterion 1, the Word half: opens a .docx in Microsoft Word and reads its Office math:
# the number of equations and, for each, the types of its top-level functions (OMath.Functions;
# wdOMathFunctionType: 7 fraction, 13 n-ary, 16 radical, 5 delimiter, 12 matrix, 1 accent, 17-19
# scripts, 20 text). Usage (Windows PowerShell 5.1 or PowerShell 7 with Word installed):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File read-math.ps1 -File <doc.docx> -Out <result.json>
#
# The file is opened read-only, invisible, with alerts off and without the repair option, so a
# package Word has to repair fails instead of being repaired. Nothing is saved.
param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($File, $false, $true, $false, [Type]::Missing, [Type]::Missing, $false, [Type]::Missing, [Type]::Missing, [Type]::Missing, [Type]::Missing, $false, $false)
  $maths = New-Object System.Collections.ArrayList
  foreach ($om in $doc.OMaths) {
    $types = @()
    foreach ($f in $om.Functions) { $types += [int]$f.Type }
    [void]$maths.Add([ordered]@{ text = [string]$om.Range.Text; functions = $types })
  }
  $result = [ordered]@{ word = [string]$word.Version; count = [int]$doc.OMaths.Count; maths = $maths }
  $doc.Close([ref]0)
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out -Encoding UTF8
} finally {
  try { $word.Quit([ref]0) } catch { }
}
