param([string]$Out)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$ns = 'xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"'
try {
  $doc = $word.Documents.Add()
  $s1 = "<b:Source $ns><b:Tag>Ito21</b:Tag><b:SourceType>BookSection</b:SourceType><b:Author><b:Author><b:NameList><b:Person><b:Last>Ito</b:Last><b:First>Mika</b:First><b:Middle>K</b:Middle></b:Person></b:NameList></b:Author><b:Editor><b:NameList><b:Person><b:Last>Brown</b:Last><b:First>Pat</b:First></b:Person></b:NameList></b:Editor></b:Author><b:Title>Fragments of Layout</b:Title><b:BookTitle>Collected Essays on Pages</b:BookTitle><b:Year>2021</b:Year><b:Month>March</b:Month><b:Day>14</b:Day><b:City>Osaka</b:City><b:Publisher>Harbour House</b:Publisher><b:Pages>55-80</b:Pages><b:Comments>Chapter 4</b:Comments></b:Source>"
  $s2 = "<b:Source $ns><b:Tag>WG22</b:Tag><b:SourceType>Report</b:SourceType><b:Author><b:Author><b:Corporate>Working Group on Fields</b:Corporate></b:Author></b:Author><b:Title>Field Codes in Practice</b:Title><b:Year>2022</b:Year><b:Publisher>WGF</b:Publisher><b:URL>https://example.org/report</b:URL></b:Source>"
  $s3 = "<b:Source $ns><b:Tag>Art23</b:Tag><b:SourceType>Art</b:SourceType><b:Author><b:Author><b:NameList><b:Person><b:Last>Vega</b:Last><b:First>Ana</b:First></b:Person></b:NameList></b:Author></b:Author><b:Title>Study in Grey</b:Title><b:Year>2023</b:Year></b:Source>"
  foreach ($s in @($s1, $s2, $s3)) { [void]$doc.Bibliography.Sources.Add($s) }
  $doc.Bibliography.BibliographyStyle = 'Chicago'
  $r = $doc.Content
  $r.Text = 'As argued '
  $r.Collapse(0)
  [void]$doc.Fields.Add($r, -1, 'CITATION Ito21 \l 1033 \p 57', $false)
  $r = $doc.Content; $r.Collapse(0)
  $r.InsertAfter(', and in the report ')
  $r.Collapse(0)
  [void]$doc.Fields.Add($r, -1, 'CITATION WG22 \l 2057', $false)
  $r = $doc.Content; $r.Collapse(0)
  $r.InsertAfter(' (see also ')
  $r.Collapse(0)
  [void]$doc.Fields.Add($r, -1, 'CITATION Art23 \l 1033 \m Ito21 \y', $false)
  $r = $doc.Content; $r.Collapse(0)
  $r.InsertAfter(').')
  [void]$doc.Fields.Update()
  # one citation in bold, to carry run formatting
  $f = $doc.Fields.Item(1)
  $f.Result.Font.Bold = 1
  $doc.SaveAs2($Out, 16)
  $doc.Close([ref]0)
  'ok'
} finally { try { $word.Quit([ref]0) } catch {} }
