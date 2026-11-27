param([string]$Out)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Add()
  $src1 = '<b:Source xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"><b:Tag>Smi20</b:Tag><b:SourceType>Book</b:SourceType><b:Author><b:Author><b:NameList><b:Person><b:Last>Smith</b:Last><b:First>Ada</b:First></b:Person></b:NameList></b:Author></b:Author><b:Title>Notes on Editors</b:Title><b:Year>2020</b:Year><b:City>London</b:City><b:Publisher>Example Press</b:Publisher></b:Source>'
  $src2 = '<b:Source xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"><b:Tag>Lee19</b:Tag><b:SourceType>JournalArticle</b:SourceType><b:Author><b:Author><b:NameList><b:Person><b:Last>Lee</b:Last><b:First>Sam</b:First></b:Person></b:NameList></b:Author></b:Author><b:Title>Fields in Word Documents</b:Title><b:JournalName>Journal of Examples</b:JournalName><b:Year>2019</b:Year><b:Pages>10-20</b:Pages><b:Volume>4</b:Volume></b:Source>'
  [void]$doc.Bibliography.Sources.Add($src1)
  [void]$doc.Bibliography.Sources.Add($src2)
  $doc.Bibliography.BibliographyStyle = 'APA'
  $r = $doc.Content
  $r.Text = 'Editors differ in how they store text '
  $r.Collapse(0)
  [void]$doc.Fields.Add($r, -1, 'CITATION Smi20 \l 1033', $false)
  $r = $doc.Content; $r.Collapse(0)
  $r.InsertAfter(' and in how they keep fields ')
  $r.Collapse(0)
  [void]$doc.Fields.Add($r, -1, 'CITATION Lee19 \l 1033 \m Smi20', $false)
  $r = $doc.Content; $r.Collapse(0)
  $r.InsertAfter('. The author alone: ')
  $r.Collapse(0)
  [void]$doc.Fields.Add($r, -1, 'CITATION Smi20 \l 1033 \n', $false)
  $r = $doc.Content; $r.Collapse(0)
  $r.InsertParagraphAfter()
  $r = $doc.Content; $r.Collapse(0)
  [void]$doc.Fields.Add($r, -1, 'BIBLIOGRAPHY \l 1033', $false)
  [void]$doc.Fields.Update()
  $doc.SaveAs2($Out, 16)
  $doc.Close([ref]0)
  'ok'
} finally { try { $word.Quit([ref]0) } catch {} }
