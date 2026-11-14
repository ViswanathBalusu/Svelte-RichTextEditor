# Quits the running Word instance only when it is an invisible automation instance (one the check
# scripts started), discarding its documents. Refuses an instance the user may be working in.
# Windows PowerShell 5.1.
try { $w = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') } catch { 'no Word instance'; exit 0 }
if ($w.Visible -or $w.UserControl) { 'not quitting: the instance may belong to the user'; exit 1 }
foreach ($d in @($w.Documents)) { $d.Saved = $true }
$w.Quit()
'quit requested'
