"""EXP-097: python-docx on one file. Prints one JSON line: ok, time, peak memory, the counts that
the high-level API exposes, and the text of the body (paragraphs and table cells).

python-docx is not a dependency of the repository: it is installed in a scratch virtual
environment (pip install python-docx==1.2.0). Tracked changes and footnotes have no API in this
version, so their counts are zero; the text is what `paragraph.text` returns.
"""
import ctypes
import ctypes.wintypes
import json
import sys
import time

import docx


def peak_mb():
    class Counters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.wintypes.DWORD),
            ("PageFaultCount", ctypes.wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    c = Counters()
    c.cb = ctypes.sizeof(c)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = ctypes.wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.wintypes.HANDLE, ctypes.c_void_p, ctypes.wintypes.DWORD]
    psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    return c.PeakWorkingSetSize / (1024 * 1024)


def texts(container):
    out = []
    for p in container.paragraphs:
        out.append(p.text)
    for t in container.tables:
        for row in t.rows:
            for cell in row.cells:
                out.extend(texts(cell))
    return out


t0 = time.perf_counter()
try:
    d = docx.Document(sys.argv[1])
    paragraphs = d.paragraphs
    line = {
        "ok": True,
        "ms": (time.perf_counter() - t0) * 1000,
        "counts": {
            "tables": len(d.tables),
            "images": len(d.inline_shapes),
            "tracked": 0,
            "comments": len(list(d.comments)),
            "footnotes": 0,
            "hyperlinks": sum(len(p.hyperlinks) for p in paragraphs),
        },
        "text": "\n".join(texts(d)),
    }
except Exception as e:  # noqa: BLE001 - the evaluation records every failure
    line = {
        "ok": False,
        "ms": (time.perf_counter() - t0) * 1000,
        "error": f"{type(e).__name__}: {e}"[:200],
    }
line["peakMb"] = peak_mb()
print(json.dumps(line))
