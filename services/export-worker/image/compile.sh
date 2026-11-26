#!/bin/sh
# compile.sh: entry point of the export worker image (spike S4, SPK-017).
#
# Standard input: a tar of the bundle. Standard output: a tar of the allow-listed outputs.
# Standard error: short status lines. Runs as an unprivileged user in a read-only container whose
# only writable path is the /work tmpfs; nothing a job writes survives the container.
#
# Passes: at least DOCEDIT_MIN_PASSES, at most DOCEDIT_MAX_PASSES. After each pass from the
# minimum on, the auxiliary files are compared with the previous pass; when they are unchanged the
# page references have converged (09 §8). Every pass starts from this job's own files only.
#
# Citations (EXP-121): when a pass leaves a changed main.bcf (biblatex's control file), biber reads
# it with the same sandbox rules and the same timeout as a pass, and writes main.bbl, which the next
# pass reads. Each run is a line iber <rc> <ms> of timings.txt, and main.bbl and main.bcf join the
# files compared for convergence. A document with no citations has no main.bcf and runs no biber.
set -u
umask 077

MIN=${DOCEDIT_MIN_PASSES:-2}
MAX=${DOCEDIT_MAX_PASSES:-4}
PASS_TIMEOUT=${DOCEDIT_PASS_TIMEOUT:-110}
JOB=/work/job

mkdir -p "$JOB" /work/.texmf-var/luatex-cache/generic || exit 70
# luaotfload reads font caches from the read-only image, but looks for its names database only in
# the writable cache root; without this copy the first pass rebuilds it (about 6.5 s).
cp -r /opt/docedit/luaotfload-names /work/.texmf-var/luatex-cache/generic/names || exit 70
cd "$JOB" || exit 70
if ! tar -x -f - --no-same-owner --no-same-permissions 2>/dev/null; then
  echo "bundle: unreadable archive" >&2
  exit 65
fi
if [ ! -f main.tex ]; then
  echo "bundle: no main.tex" >&2
  exit 65
fi

now() { date +%s%N; }
: > timings.txt
prev=""
bprev=""
pass=0
status=0
converged=0
while [ "$pass" -lt "$MAX" ]; do
  pass=$((pass + 1))
  t0=$(now)
  timeout -s KILL "$PASS_TIMEOUT" lualatex --interaction=nonstopmode --halt-on-error \
    --no-shell-escape --file-line-error main.tex > /dev/null 2>&1
  rc=$?
  t1=$(now)
  echo "$pass $rc $(( (t1 - t0) / 1000000 ))" >> timings.txt
  if [ "$rc" -ne 0 ]; then
    status=$rc
    break
  fi
  if [ -f main.bcf ]; then
    bcur=$(sha256sum main.bcf | cut -c1-64)
    if [ "$bcur" != "$bprev" ]; then
      bprev=$bcur
      b0=$(now)
      # TMPDIR: the image is read-only and biber makes temporary files; /work is writable.
      TMPDIR=/work timeout -s KILL "$PASS_TIMEOUT" biber --quiet main > /dev/null 2>&1
      brc=$?
      b1=$(now)
      echo "biber $brc $(( (b1 - b0) / 1000000 ))" >> timings.txt
      # Biber returns 0, or 1 for warnings; 2 and more are errors, and a kill is 137.
      if [ "$brc" -ge 2 ]; then
        status=$brc
        break
      fi
      # The pass just made used the old bibliography: another pass is needed.
      prev="biber"
      continue
    fi
  fi
  cur=$(cat main.aux main.toc main.out main.bbl 2> /dev/null | sha256sum | cut -c1-64)
  if [ "$pass" -ge "$MIN" ] && [ "$cur" = "$prev" ]; then
    converged=1
    break
  fi
  prev=$cur
done
echo "converged $converged" >> timings.txt

# Only these files leave the sandbox; the worker reads them as hostile input.
set --
for f in main.pdf main.log main.layout main.blg timings.txt; do
  [ -f "$f" ] && set -- "$@" "$f"
done
tar -c -f - --no-recursion "$@" 2> /dev/null
exit "$status"
