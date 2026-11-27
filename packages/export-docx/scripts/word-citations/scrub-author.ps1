param([string]$Path)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::Open($Path, 'Update')
try {
  $e = $z.GetEntry('docProps/core.xml')
  $sr = New-Object IO.StreamReader($e.Open())
  $t = $sr.ReadToEnd()
  $sr.Dispose()
  $e.Delete()
  $t = [regex]::Replace($t, '<dc:creator>[^<]*</dc:creator>', '<dc:creator>Author</dc:creator>')
  $t = [regex]::Replace($t, '<cp:lastModifiedBy>[^<]*</cp:lastModifiedBy>', '<cp:lastModifiedBy>Author</cp:lastModifiedBy>')
  $n = $z.CreateEntry('docProps/core.xml')
  $w = New-Object IO.StreamWriter($n.Open(), (New-Object Text.UTF8Encoding($false)))
  $w.Write($t)
  $w.Dispose()
} finally { $z.Dispose() }
$z = [IO.Compression.ZipFile]::OpenRead($Path)
$hits = 0
foreach ($en in $z.Entries) {
  $r = New-Object IO.StreamReader($en.Open())
  $s = $r.ReadToEnd(); $r.Dispose()
  if ($s -match 'Balusu|Chandra|ckvba|Viswanath') { $hits++; "HIT $($en.FullName)" }
}
$z.Dispose()
"$Path hits=$hits"
