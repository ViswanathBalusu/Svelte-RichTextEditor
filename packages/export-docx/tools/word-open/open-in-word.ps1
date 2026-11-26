# EXP-090 criterion 1, the Word half: opens each .docx of a list in Microsoft Word and records
# whether it opened. Usage (Windows PowerShell 5.1 or PowerShell 7 with Word installed):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File open-in-word.ps1 -List <files.txt> -Out <result.json>
#
# How: Word opens each file read-only, invisible, with alerts off and without the repair option
# (Documents.Open with OpenAndRepair false). A package that holds unreadable content then fails
# with "Word experienced an error trying to open the file" instead of showing the repair prompt
# and being repaired, so "opened" here means "opened without a repair prompt". The test that runs
# this script also gives it a damaged copy and requires that one to fail. No file is saved and no
# Word setting is changed. After a failure the Word instance is replaced, so one bad file does not
# disturb the next.
param(
  [Parameter(Mandatory = $true)][string]$List,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$files = @(Get-Content -LiteralPath $List | Where-Object { $_.Trim() -ne '' })
$rows = New-Object System.Collections.ArrayList
$word = $null
function Start-WordInstance {
  $w = New-Object -ComObject Word.Application
  $w.Visible = $false
  $w.DisplayAlerts = 0
  return $w
}
function Stop-WordInstance($w) {
  if ($null -ne $w) { try { $w.Quit([ref]0) } catch { } }
}
try {
  $word = Start-WordInstance
  $version = [string]$word.Version
  foreach ($f in $files) {
    $row = [ordered]@{ file = [string]$f; opened = $false; paragraphs = 0; error = $null }
    try {
      # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument,
      # PasswordTemplate, Revert, WritePasswordDocument, WritePasswordTemplate, Format, Encoding,
      # Visible, OpenAndRepair)
      $doc = $word.Documents.Open($f, $false, $true, $false, [Type]::Missing, [Type]::Missing, $false, [Type]::Missing, [Type]::Missing, [Type]::Missing, [Type]::Missing, $false, $false)
      $row.opened = $true
      $row.paragraphs = [int]$doc.Paragraphs.Count
      $doc.Close([ref]0)
    } catch {
      $row.error = $_.Exception.Message
      Stop-WordInstance $word
      $word = Start-WordInstance
    }
    [void]$rows.Add($row)
  }
} finally {
  Stop-WordInstance $word
}
$result = [ordered]@{ word = $version; rows = $rows }
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Out -Encoding UTF8
