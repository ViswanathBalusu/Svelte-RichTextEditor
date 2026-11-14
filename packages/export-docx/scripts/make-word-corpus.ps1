# Builds Word-authored corpus files for S11 (SPK-028) with the installed Microsoft Word, through
# COM. Windows PowerShell 5.1:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File make-word-corpus.ps1 -Out <directory>
#
# NOT USED for the committed corpus: on the spike machine (Word 16.0 build 16.0.20527) every
# feature below was added, but Document.SaveAs2 then blocked without any visible prompt (the first
# probe of the day had saved; see the S11 report §8). Run it with a timeout, on a machine where an
# automation instance of Word can save, and check the output for personal data before committing.
#
# The files are the project's own (Apache-2.0, like the repository). Word writes the user's name
# and initials into core properties, comments, revisions and people.xml. No Word setting is
# changed (the document setting "remove personal information" makes Word show a blocking warning
# on save); instead each saved package is scrubbed: those values become "Author" and "A", presence
# information and the company name are removed, and the script checks that neither the name nor
# the initials remain in any XML part. Everything else is as Word wrote it. Each feature is added
# in its own try/catch, so a feature Word refuses is reported and the rest of the file is written.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$missing = [System.Reflection.Missing]::Value

# A small picture for the picture features.
Add-Type -AssemblyName System.Drawing
$png = Join-Path $Out 'picture.png'
$bmp = New-Object System.Drawing.Bitmap 96, 48
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 30, 90, 160))
$g.FillEllipse([System.Drawing.Brushes]::Gold, 8, 8, 80, 32)
$g.Dispose(); $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
"Word $($word.Version) build $($word.Build)"

function Try-Feature([string]$name, [scriptblock]$body) {
  try { & $body; "  ok      $name" } catch { "  FAILED  $name : $($_.Exception.Message)" }
}

function New-Doc { return $word.Documents.Add() }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$userName = $word.UserName
$userInitials = $word.UserInitials

function Escape-Xml([string]$s) { return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;') }

# Replaces the user's name and initials in the places Word writes them; returns how many XML parts
# still contain either afterwards (0 is required).
function Scrub-Package([string]$path) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $names = @($userName, (Escape-Xml $userName)) | Select-Object -Unique
  $inits = @($userInitials, (Escape-Xml $userInitials)) | Select-Object -Unique
  $zip = [System.IO.Compression.ZipFile]::Open($path, 'Update')
  try {
    foreach ($e in @($zip.Entries)) {
      if ($e.FullName -notmatch '\.(xml|rels)$') { continue }
      $reader = New-Object System.IO.StreamReader($e.Open(), $utf8); $text = $reader.ReadToEnd(); $reader.Close()
      $new = $text
      foreach ($n in $names) {
        foreach ($a in 'w:author', 'w15:author') { $new = $new.Replace("$a=`"$n`"", "$a=`"Author`"") }
        $new = $new.Replace("<dc:creator>$n</dc:creator>", '<dc:creator>Author</dc:creator>').Replace("<cp:lastModifiedBy>$n</cp:lastModifiedBy>", '<cp:lastModifiedBy>Author</cp:lastModifiedBy>')
      }
      foreach ($i in $inits) { $new = $new.Replace("w:initials=`"$i`"", 'w:initials="A"') }
      $new = [regex]::Replace($new, '<w15:presenceInfo [^>]*/>', '')
      $new = [regex]::Replace($new, '<Company>[^<]*</Company>', '<Company></Company>')
      if ($new -ne $text) {
        $name = $e.FullName; $e.Delete()
        $w = New-Object System.IO.StreamWriter($zip.CreateEntry($name).Open(), $utf8); $w.Write($new); $w.Close()
      }
    }
  } finally { $zip.Dispose() }
  $left = 0
  $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
  try {
    foreach ($e in $zip.Entries) {
      if ($e.FullName -notmatch '\.(xml|rels)$') { continue }
      $reader = New-Object System.IO.StreamReader($e.Open(), $utf8); $text = $reader.ReadToEnd(); $reader.Close()
      $found = $false
      foreach ($n in $names) { if ($n.Length -gt 0 -and $text.Contains($n)) { $found = $true } }
      foreach ($i in $inits) { if ($i.Length -gt 1 -and ($text.Contains("`"$i`"") -or $text.Contains(">$i<"))) { $found = $true } }
      if ($found) { $left++ }
    }
  } finally { $zip.Dispose() }
  return $left
}

function Save-Doc($doc, [string]$name) {
  $path = Join-Path $Out $name
  $doc.SaveAs2($path, 16, $false, '', $false)
  $doc.Saved = $true
  $doc.Close()
  $left = Scrub-Package $path
  if ($left -ne 0) { Remove-Item $path; "REMOVED $name : personal values remained in $left parts" } else { "saved $name (scrubbed)" }
}

try {
  # 1. Headings, a table of contents, fields, bookmarks, cross-references, captions, hyperlinks.
  $doc = New-Doc; $sel = $word.Selection
  $sel.Style = $doc.Styles.Item(-63); $sel.TypeText('S11 fields and references'); $sel.TypeParagraph()
  $sel.Style = $doc.Styles.Item(-1)
  Try-Feature 'table of contents' { $doc.TablesOfContents.Add($sel.Range, $true, 1, 3) | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph() }
  foreach ($h in 1..3) {
    $sel.Style = $doc.Styles.Item(-2); $sel.TypeText("Chapter $h"); $sel.TypeParagraph()
    $sel.Style = $doc.Styles.Item(-1); $sel.TypeText("Body text of chapter $h. "); $sel.TypeParagraph()
    $sel.Style = $doc.Styles.Item(-3); $sel.TypeText("Section $h.1"); $sel.TypeParagraph()
    $sel.Style = $doc.Styles.Item(-1); $sel.TypeText('More text in a sub-section.'); $sel.TypeParagraph()
  }
  Try-Feature 'bookmark and REF field' {
    $sel.TypeText('Bookmarked words'); $r = $doc.Range($sel.Start - 16, $sel.Start); $doc.Bookmarks.Add('s11target', $r) | Out-Null
    $sel.TypeText(' are referred to here: '); $doc.Fields.Add($sel.Range, -1, 'REF s11target \h', $false) | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph()
  }
  Try-Feature 'PAGE, NUMPAGES and DATE fields' {
    $sel.TypeText('Page '); $doc.Fields.Add($sel.Range, 33) | Out-Null; $sel.EndKey(6) | Out-Null
    $sel.TypeText(' of '); $doc.Fields.Add($sel.Range, 26) | Out-Null; $sel.EndKey(6) | Out-Null
    $sel.TypeText(', printed on '); $doc.Fields.Add($sel.Range, 31, '\@ "d MMMM yyyy"', $false) | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph()
  }
  Try-Feature 'caption with SEQ field' { $sel.InsertCaption('Table', ': a caption with a sequence field', '', 0); $sel.EndKey(6) | Out-Null; $sel.TypeParagraph() }
  Try-Feature 'hyperlink' { $sel.TypeText('A link: '); $doc.Hyperlinks.Add($sel.Range, 'https://example.org/s11', $missing, 'Example', 'example.org') | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph() }
  Try-Feature 'update table of contents' { $doc.TablesOfContents.Item(1).Update() }
  Save-Doc $doc 'w365-fields.docx'

  # 2. Review: comments with a reply, tracked insertions, deletions, formatting and a move.
  $doc = New-Doc; $sel = $word.Selection
  $sel.TypeText('First paragraph, which gets a comment.'); $sel.TypeParagraph()
  $sel.TypeText('Second paragraph, part of which is deleted with tracking on.'); $sel.TypeParagraph()
  $sel.TypeText('Third paragraph, which becomes bold with tracking on.'); $sel.TypeParagraph()
  $sel.TypeText('Fourth paragraph.'); $sel.TypeParagraph()
  Try-Feature 'comment with reply' { $c = $doc.Comments.Add($doc.Paragraphs.Item(1).Range, 'A comment on the first paragraph.'); $c.Replies.Add($c.Scope, 'A reply to it.') | Out-Null }
  $doc.TrackRevisions = $true
  Try-Feature 'tracked insertion' { $r = $doc.Paragraphs.Item(4).Range; $r.MoveEnd(1, -1) | Out-Null; $r.InsertAfter(' Inserted with tracking on.') }
  Try-Feature 'tracked deletion' { $r = $doc.Paragraphs.Item(2).Range; $doc.Range($r.Start + 19, $r.Start + 40).Delete() | Out-Null }
  Try-Feature 'tracked formatting' { $doc.Paragraphs.Item(3).Range.Font.Bold = $true }
  Try-Feature 'tracked paragraph insertion' { $r = $doc.Paragraphs.Item(4).Range; $r.InsertParagraphAfter(); $doc.Paragraphs.Item(5).Range.InsertBefore('A new paragraph inserted with tracking on.') }
  $doc.TrackRevisions = $false
  Save-Doc $doc 'w365-review.docx'

  # 3. Drawing: text box, shapes, SmartArt, pictures, Office math, text effects.
  $doc = New-Doc; $sel = $word.Selection
  $sel.TypeText('A paragraph with a floating text box and a shape anchored to it.'); $sel.TypeParagraph()
  $anchor = $doc.Paragraphs.Item(1).Range
  Try-Feature 'text box' { $tb = $doc.Shapes.AddTextbox(1, 72, 100, 220, 60, $anchor); $tb.TextFrame.TextRange.Text = 'Text inside a text box.' }
  Try-Feature 'shape with text' { $sh = $doc.Shapes.AddShape(9, 320, 100, 140, 70, $anchor); $sh.TextFrame.TextRange.Text = 'An ellipse' }
  $sel.EndKey(6) | Out-Null
  $sel.TypeText('An inline picture: '); Try-Feature 'inline picture' { $p = $doc.InlineShapes.AddPicture($png, $false, $true, $sel.Range); $p.AlternativeText = 'A gold ellipse on blue' }
  $sel.EndKey(6) | Out-Null; $sel.TypeParagraph()
  $sel.TypeText('A paragraph with a floating picture.'); $sel.TypeParagraph()
  Try-Feature 'floating picture' { $doc.Shapes.AddPicture($png, $false, $true, 300, 260, 96, 48, $doc.Paragraphs.Item($doc.Paragraphs.Count - 1).Range) | Out-Null }
  $sel.EndKey(6) | Out-Null
  $sel.TypeText('A SmartArt graphic follows.'); $sel.TypeParagraph()
  Try-Feature 'SmartArt' { $doc.InlineShapes.AddSmartArt($word.SmartArtLayouts.Item(1), $sel.Range) | Out-Null }
  $sel.EndKey(6) | Out-Null; $sel.TypeParagraph()
  Try-Feature 'display equation' { $sel.TypeText('x=(-b' + [char]0x00B1 + [char]0x221A + '(b^2-4ac))/2a'); $r = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range; $m = $r.OMaths.Add($r); $m.OMaths.Item(1).BuildUp() | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph() }
  Try-Feature 'inline equation' { $sel.TypeText('Inline math: '); $s0 = $sel.Start; $sel.TypeText('a^2+b^2=c^2'); $r = $doc.Range($s0, $sel.Start); $m = $r.OMaths.Add($r); $m.OMaths.Item(1).BuildUp() | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeText(' in a sentence.'); $sel.TypeParagraph() }
  Try-Feature 'text effects' { $sel.TypeText('Glowing words'); $r = $doc.Range($sel.Start - 13, $sel.Start); $r.Font.Glow.Radius = 6; $r.Font.Glow.Color.RGB = 0x00C000; $sel.TypeParagraph() }
  Save-Doc $doc 'w365-drawing.docx'

  # 4. Structure: nested tables, content controls, sections, headers and footers, notes.
  $doc = New-Doc; $sel = $word.Selection
  $sel.TypeText('A table with a nested table in its first cell.'); $sel.TypeParagraph()
  Try-Feature 'nested table' {
    $t = $doc.Tables.Add($sel.Range, 2, 3); $t.Borders.Enable = 1
    foreach ($row in 1..2) { foreach ($col in 1..3) { $t.Cell($row, $col).Range.Text = "R$row C$col" } }
    $inner = $t.Cell(1, 1).Tables.Add($t.Cell(1, 1).Range, 2, 2); $inner.Borders.Enable = 1
    $inner.Cell(1, 1).Range.Text = 'inner'
    $t.Cell(2, 2).Merge($t.Cell(2, 3))
    $sel.EndKey(6) | Out-Null
  }
  $sel.TypeParagraph()
  Try-Feature 'content controls' {
    $sel.TypeText('Plain text control: '); $cc = $doc.ContentControls.Add(1, $sel.Range); $cc.Title = 'Name'; $cc.Tag = 's11-name'; $cc.Range.Text = 'filled in'; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph()
    $sel.TypeText('Check box: '); $doc.ContentControls.Add(8, $sel.Range) | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph()
    $sel.TypeText('Date: '); $d = $doc.ContentControls.Add(6, $sel.Range); $d.DateDisplayFormat = 'yyyy-MM-dd'; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph()
    $sel.TypeText('Choice: '); $dd = $doc.ContentControls.Add(4, $sel.Range); $dd.DropdownListEntries.Add('Option A') | Out-Null; $dd.DropdownListEntries.Add('Option B') | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeParagraph()
  }
  Try-Feature 'footnote and endnote' {
    $sel.TypeText('A sentence with a footnote'); $doc.Footnotes.Add($sel.Range, $missing, 'The footnote text.') | Out-Null; $sel.EndKey(6) | Out-Null
    $sel.TypeText(' and an endnote'); $doc.Endnotes.Add($sel.Range, $missing, 'The endnote text.') | Out-Null; $sel.EndKey(6) | Out-Null; $sel.TypeText('.'); $sel.TypeParagraph()
  }
  Try-Feature 'landscape section' { $sel.InsertBreak(2); $sel.TypeText('This section is landscape.'); $sel.TypeParagraph(); $doc.Sections.Item(2).PageSetup.Orientation = 1 }
  Try-Feature 'two-column section' { $sel.InsertBreak(3); $sel.TypeText('This continuous section has two columns. ' * 12); $sel.TypeParagraph(); $doc.Sections.Item(3).PageSetup.TextColumns.SetCount(2) }
  Try-Feature 'headers and footers' {
    $s1 = $doc.Sections.Item(1); $s1.PageSetup.DifferentFirstPageHeaderFooter = -1
    $s1.Headers.Item(1).Range.Text = 'Default header'; $s1.Headers.Item(2).Range.Text = 'First-page header'
    $s1.Footers.Item(1).PageNumbers.Add(1, $true) | Out-Null
    $s2 = $doc.Sections.Item(2); $s2.Headers.Item(1).LinkToPrevious = $false; $s2.Headers.Item(1).Range.Text = 'Header of the landscape section'
  }
  Save-Doc $doc 'w365-structure.docx'
} finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  Remove-Item $png -ErrorAction SilentlyContinue
}
