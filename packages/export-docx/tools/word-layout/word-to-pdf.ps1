# EXP-115: lets Word lay out each .docx in a folder and saves the result as <name>.pdf next to it.
#
# Usage (Windows PowerShell 5.1 or PowerShell 7 with Word installed):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File word-to-pdf.ps1 -Dir <folder>
#
# How: one Word instance opens each *.docx read-only, invisible, with alerts off. Every field of
# the document is updated first (a SEQ or REF field shows its counted value, as it does after
# Ctrl+A, F9), then the document is exported as PDF. No .docx is saved, no setting is changed and
# Word is quit at the end. The test reads the PDFs with pdftotext.
param(
  [Parameter(Mandatory = $true)][string]$Dir
)
$ErrorActionPreference = 'Stop'
$files = Get-ChildItem -Path $Dir -Filter *.docx | Sort-Object Name
$word = New-Object -ComObject Word.Application
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  foreach ($file in $files) {
    $pdf = [System.IO.Path]::ChangeExtension($file.FullName, '.pdf')
    if (Test-Path $pdf) { Remove-Item $pdf -Force }
    $doc = $word.Documents.Open($file.FullName, $false, $true, $false)
    try {
      [void]$doc.Fields.Update()
      foreach ($story in $doc.StoryRanges) {
        $r = $story
        while ($null -ne $r) { [void]$r.Fields.Update(); $r = $r.NextStoryRange }
      }
      $doc.Repaginate()
      # 17 = wdFormatPDF (SaveAs2 to a new name; the .docx itself is not changed)
      $pdfRef = [ref]$pdf; $fmt = [ref]17; $doc.SaveAs2($pdfRef, $fmt)
    } catch {
      Write-Error "$($file.Name): $_" -ErrorAction Continue
    } finally {
      $doc.Close([ref]0)
    }
  }
} finally {
  # Other runs may share this Word: quit it only when no document is open.
  if ($word.Documents.Count -eq 0) { $word.Quit([ref]0) }
}
