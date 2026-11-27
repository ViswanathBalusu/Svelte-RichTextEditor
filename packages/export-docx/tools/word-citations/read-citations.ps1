# EXP-122 criterion 1, the Word half: opens a .docx in Microsoft Word, reads the document's
# bibliography sources and its citation fields, updates every field and reads the citation results
# again. Usage (Windows PowerShell 5.1 or PowerShell 7 with Word installed):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File read-citations.ps1 -File <doc.docx> -Out <result.json>
#
# The file is opened read-only, invisible, with alerts off and without the repair option, so a
# package Word has to repair fails instead of being repaired. Nothing is saved. A citation field
# whose source Word does not know gets the text "Invalid source specified." when it is updated, so
# the updated result shows whether Word could use the sources part.
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
  $sources = @()
  foreach ($s in $doc.Bibliography.Sources) { $sources += [string]$s.Tag }
  $fields = New-Object System.Collections.ArrayList
  foreach ($f in $doc.Fields) {
    if ($f.Type -ne 96) { continue }
    $before = [string]$f.Result.Text
    $code = ([string]$f.Code.Text).Trim()
    [void]$f.Update()
    [void]$fields.Add([ordered]@{ code = $code; before = $before; after = [string]$f.Result.Text })
  }
  $result = [ordered]@{
    word = [string]$word.Version
    sourceCount = [int]$doc.Bibliography.Sources.Count
    sources = $sources
    fields = $fields
  }
  $doc.Close([ref]0)
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Out -Encoding UTF8
} finally {
  try { $word.Quit([ref]0) } catch { }
}
