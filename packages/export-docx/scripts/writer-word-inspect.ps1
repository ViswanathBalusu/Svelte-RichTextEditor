# Reports what Word shows for each .docx under a directory (EXP-090 criteria 2 and 3): per paragraph
# the list label Word computes (Range.ListFormat.ListString), the style, and the font of the first
# character (name, size, bold, italic), and per document the number of sections, footnotes, fields
# and revisions. Windows PowerShell 5.1:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File writer-word-inspect.ps1 -Dir <dir> -Result <file.json>
#
# Word runs invisible with alerts off and opens each file read-only, without repair and without
# adding it to the recent list; nothing is saved and no setting is changed. Only files that the
# open check (word-open-check.ps1) opened without a prompt should be given here. Word is quit at the
# end, also after an error.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Result
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $Dir).Path
$files = @(Get-ChildItem -Path $root -Recurse -Filter *.docx | Sort-Object FullName)
$missing = [System.Reflection.Missing]::Value
$word = New-Object -ComObject Word.Application
$out = New-Object System.Collections.ArrayList
$version = ''
try {
  $version = "$($word.Version) build $($word.Build)"
  $word.Visible = $false
  $word.DisplayAlerts = 0
  foreach ($f in $files) {
    $doc = $word.Documents.Open($f.FullName, $false, $true, $false, '', '', $false, '', '', 0, $missing, $false, $false, $missing, $true)
    try {
      $paras = New-Object System.Collections.ArrayList
      foreach ($p in $doc.Paragraphs) {
        $r = $p.Range
        $first = $r.Characters.Item(1)
        $text = $r.Text
        if ($text.Length -gt 80) { $text = $text.Substring(0, 80) }
        [void]$paras.Add([pscustomobject]@{
          text = $text.TrimEnd([char]13, [char]7)
          list = $r.ListFormat.ListString
          style = $p.Style.NameLocal
          font = $first.Font.Name
          size = $first.Font.Size
          bold = [bool]$first.Font.Bold
          italic = [bool]$first.Font.Italic
        })
      }
      [void]$out.Add([pscustomobject]@{
        file = $f.FullName.Substring($root.Length).TrimStart('\')
        sections = $doc.Sections.Count
        footnotes = $doc.Footnotes.Count
        fields = $doc.Fields.Count
        revisions = $doc.Revisions.Count
        paragraphs = @($paras)
      })
    } finally {
      $doc.Saved = $true
      $doc.Close()
    }
  }
} finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
[pscustomobject]@{ word = $version; checked = (Get-Date -Format o); files = @($out) } | ConvertTo-Json -Depth 5 | Set-Content -Path $Result -Encoding UTF8
"inspected $($out.Count) files"
