# EXP-100 criterion 3: lets Word open each .docx of a folder and writes, for every list paragraph of
# its main text, the label Word displays (ListFormat.ListString) and the list type, to one JSON file.
#
# The folder is searched recursively; each file is keyed by its path under it, with forward slashes.
#
# Usage (Windows PowerShell 5.1 or PowerShell 7 with Word installed):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File word-list-strings.ps1 -Dir <folder> -Out <file.json>
#
# How: one Word instance opens each *.docx read-only, invisible, with alerts off, and reads
# every paragraph's ListFormat. No .docx is saved and no setting is changed. A file Word cannot open gets an
# `error` instead of a list. Word is quit at the end when no other document is open.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $Dir).Path.TrimEnd([char]92, [char]47)
$files = Get-ChildItem -Path $Dir -Filter *.docx -Recurse | Sort-Object FullName
$word = New-Object -ComObject Word.Application
$result = [ordered]@{}
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  foreach ($file in $files) {
    $doc = $null
    $key = $file.FullName.Substring($root.Length + 1).Replace([string][char]92, '/')
    try {
      $doc = $word.Documents.Open($file.FullName, $false, $true, $false)
      $items = @()
      # Every paragraph in document order: the order of ListParagraphs is not the document's.
      foreach ($p in $doc.Paragraphs) {
        $lf = $p.Range.ListFormat
        if ([int]$lf.ListType -eq 0) { continue }
        $text = $p.Range.Text
        if ($text.Length -gt 60) { $text = $text.Substring(0, 60) }
        $items += [ordered]@{ label = $lf.ListString; type = [int]$lf.ListType; text = $text.TrimEnd("`r", "`a") }
      }
      $result[$key] = @{ items = $items }
    } catch {
      $result[$key] = @{ error = "$_" }
    } finally {
      if ($null -ne $doc) { $doc.Close([ref]0) }
    }
  }
} finally {
  if ($word.Documents.Count -eq 0) { $word.Quit([ref]0) }
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding UTF8
