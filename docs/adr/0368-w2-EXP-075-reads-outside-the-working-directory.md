# ADR 0368: What "reads outside the working directory must fail" means for a compile sandbox (lane w2, EXP-075)

Status: proposed. The owner has not decided this. EXP-075 criterion 1 stays unticked until the owner does.

## Context

EXP-075 criterion 1 says that a test bundle that bypasses the converter must fail when it tries to
read a file outside its working directory, and also when it reads another job's files.

The tests in `services/export-worker/src/sandbox.escape.test.ts` and
`services/export-worker/src/exp-075-read-probe.podman.test.ts` show the following on the worker
image under Podman (2026-11-13):

- Writes outside the work directory, a read of another job's marker, host mounts, credentials,
  sockets, commands, memory, loops, forks and the disk bound all fail.
- `\openin` and `\input` of `/etc/passwd`, `../../../../etc/passwd` and `/proc/self/environ`
  succeed, although `openin_any=p` is set. A read of a file of the TeX tree succeeds by design.
- The probe is an `it.fails` test, so the suite goes red when the reads start to fail.

`openin_any=p` is the engine's second line (EXP-068). It is not a boundary: LuaTeX keeps Lua's `io`
and `debug` libraries, so any TeX injection is arbitrary Lua (the security notes of the worker
README say this). Lua reads any file that the process user can read, whatever `openin_any` says.

## Decision proposed

Read the criterion as follows. A compile must not be able to read anything that is not part of the
single-use sandbox: no host file, no other job's file, no secret, no credential, no network. Files
of the read-only image (the TeX tree, `/etc`, `/proc` of the container) are readable by design,
because the compile needs the TeX tree and the image holds nothing private.

Under this reading criterion 1 is met by the tests that exist. The probe of `/etc/passwd` stays as
a record of what the image exposes and is not a failure.

The alternative is to make every file that is not the TeX tree, the fonts or the work directory
unreadable by the compile user. That is an image-hardening task (a minimal root file system built
for the worker, EXP-073) and the compile user would still read what the TeX tree holds. It would
not be a boundary either, and it costs a second image to maintain.

## What the owner decides

1. Accept the reading above, and reword criterion 1 to "outside the sandbox" (then tick it on the
   existing tests), or
2. Keep the criterion as written and ask for the minimal root file system.

Criterion 3 (CI blocks a change to the image, the class or the sandbox configuration) is a
hosted-CI property. `.github/workflows/ci.yml` runs `services/export-worker` and
`packages/export-latex` against Podman with `DOCEDIT_REQUIRE_SANDBOX=1` on every pull request
(the job before `fuzz`), which covers a change to the image, the class or the sandbox files. Whether
a failure blocks the merge is the branch protection rule, which the workflow's header says is
configured on the host and which cannot be read from this checkout. No hosted run was seen, so the
criterion stays unticked.
