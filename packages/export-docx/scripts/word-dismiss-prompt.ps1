# Closes the prompt dialogs (class NUIDialog, "Microsoft Word") of invisible Word instances that a
# check script started, by sending WM_CLOSE (the same as the dialog's close button). Prints the
# number of prompts closed per process; the presence of a prompt is itself the check's result.
# Windows PowerShell 5.1.
param([int[]]$ProcessIds)
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Prompt {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static int Close(uint pid) {
    int n = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() == "NUIDialog" || c.ToString() == "#32770") { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); n++; }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
foreach ($id in $ProcessIds) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p -or $p.ProcessName -ne 'WINWORD') { continue }
  "pid ${id}: closed $([Prompt]::Close([uint32]$id)) prompt(s)"
}
