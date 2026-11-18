# CDM-041 criterion 7: reads the paragraph and character formatting that Word resolves for the
# paragraph of each .docx in a folder whose text starts with "Text".
#
# Usage (Windows PowerShell 5.1 or PowerShell 7 with Word installed):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File read-word-paragraphs.ps1 -Dir <folder>
#
# How: one Word instance opens each *.docx in the folder read-only, invisible, with alerts off, and
# no file is saved and no setting is changed. For the paragraph it reads Word's own effective
# values (Paragraph.Format and the Font of the first character), not the file's XML, and writes
# <name>.word.json next to the file. Lengths are in points as Word reports them. Word is then quit.
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
    $doc = $word.Documents.Open($file.FullName, $false, $true, $false)
    try {
      $target = $null
      $n = $doc.Paragraphs.Count
      for ($i = 1; $i -le $n; $i++) {
        $p = $doc.Paragraphs.Item($i)
        if ($p.Range.Text.StartsWith('Text')) { $target = $p; break }
      }
      if ($null -eq $target) { throw "no paragraph starting with Text in $($file.Name)" }
      $f = $target.Format
      $tabs = New-Object System.Collections.ArrayList
      foreach ($t in $f.TabStops) {
        [void]$tabs.Add([ordered]@{ position = [double]$t.Position; alignment = [int]$t.Alignment; leader = [int]$t.Leader; custom = [bool]$t.CustomTab })
      }
      # The "x" of "Text": with a link, the first and last characters of the paragraph hold the field's begin and end marks and report mixed formatting.
      $c = $null
      for ($k = $target.Range.Characters.Count; $k -ge 1; $k--) {
        $ch = $target.Range.Characters.Item($k)
        if ($ch.Text -ceq 'x') { $c = $ch; break }
      }
      if ($null -eq $c) { throw "no character x in $($file.Name)" }
      $font = $c.Font
      $color = [int]$font.Color
      $colorHex = $null
      if ($color -ne -16777216) {
        $b = ($color -shr 16) -band 0xFF
        $g = ($color -shr 8) -band 0xFF
        $r = $color -band 0xFF
        $colorHex = ('{0:X2}{1:X2}{2:X2}' -f $r, $g, $b)
      }
      $result = [ordered]@{
        paragraph = [ordered]@{
          alignment = [int]$f.Alignment
          readingOrder = [int]$f.ReadingOrder
          leftIndent = [double]$f.LeftIndent
          firstLineIndent = [double]$f.FirstLineIndent
          spaceBefore = [double]$f.SpaceBefore
          spaceAfter = [double]$f.SpaceAfter
          lineSpacingRule = [int]$f.LineSpacingRule
          lineSpacing = [double]$f.LineSpacing
          keepWithNext = [bool]($f.KeepWithNext -ne 0)
          keepTogether = [bool]($f.KeepTogether -ne 0)
          pageBreakBefore = [bool]($f.PageBreakBefore -ne 0)
          widowControl = [bool]($f.WidowControl -ne 0)
          tabs = $tabs
        }
        font = [ordered]@{
          name = [string]$font.Name
          size = [double]$font.Size
          bold = [bool]($font.Bold -ne 0)
          italic = [bool]($font.Italic -ne 0)
          underline = [int]$font.Underline
          strike = [bool]($font.StrikeThrough -ne 0)
          smallCaps = [bool]($font.SmallCaps -ne 0)
          allCaps = [bool]($font.AllCaps -ne 0)
          superscript = [bool]($font.Superscript -ne 0)
          subscript = [bool]($font.Subscript -ne 0)
          hidden = [bool]($font.Hidden -ne 0)
          colorHex = $colorHex
          highlight = [int]$c.HighlightColorIndex
          languageId = [int]$c.LanguageID
        }
      }
      $json = ConvertTo-Json -InputObject $result -Depth 6
      $out = Join-Path $Dir ($file.BaseName + '.word.json')
      Set-Content -Path $out -Value $json -Encoding UTF8
    } finally {
      $doc.Close([ref]0)
    }
  }
} finally {
  $word.Quit([ref]0)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
"documents: $($files.Count)"
