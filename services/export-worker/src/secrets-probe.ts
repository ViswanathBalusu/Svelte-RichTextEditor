/**
 * The `/run/secrets` part of the sandbox readiness check (EXP-072; lane U-EXP-113-123, round 3 fix).
 *
 * Podman's default `mounts.conf` copies host files (on the WSL machine, RHEL subscription data) into
 * a directory of the container's run directory and bind-mounts it on `/run/secrets` (S4 §3). The
 * check refuses a sandbox in which `/run/secrets` exists, with one exception: an empty, read-only
 * tmpfs that the job's own arguments mount there (`--tmpfs=/run/secrets:ro`). That mount has root
 * `/` in `/proc/self/mountinfo`; a default-mounts bind has the copied directory as its root, so an
 * empty directory from the host's mounts file is still refused. Anything else is refused: an entry
 * in the directory, a second mount at or below it, a mount that is not tmpfs or not read-only, a
 * plain directory of the image, or an answer that cannot be read.
 */

/** Runs in the sandbox under `sh`. Every line it prints starts with a marker the parser knows. */
export const SECRETS_PROBE_SCRIPT = [
  'if [ -e /run/secrets ] || [ -L /run/secrets ]; then echo secrets=present; else echo secrets=absent; fi',
  // /var/run is a link to /run in the Debian base; where it is not, /var/run/secrets is checked too.
  'if [ ! -L /var/run ] && { [ -e /var/run/secrets ] || [ -L /var/run/secrets ]; }; then echo var-secrets=present; fi',
  'for f in /run/secrets/* /run/secrets/.[!.]* /run/secrets/..?*; do if [ -e "$f" ] || [ -L "$f" ]; then echo "entry=$f"; fi; done',
  'while IFS= read -r l; do case "$l" in *" /run/secrets "*|*" /run/secrets/"*|*" /var/run/secrets "*|*" /var/run/secrets/"*) echo "mount=$l";; esac; done < /proc/self/mountinfo',
  'echo sandbox-ok',
  '',
].join('\n');

export type SecretsVerdict = 'ok' | 'host-mounts' | 'no-answer';

interface MountLine {
  root: string;
  mountPoint: string;
  options: string[];
  fsType: string;
  source: string;
}

/** One line of /proc/self/mountinfo (proc(5)); null when it does not have that shape. */
export function parseMountLine(line: string): MountLine | null {
  const [left, right] = line.split(' - ');
  if (left === undefined || right === undefined) return null;
  const a = left.split(' ');
  const b = right.split(' ');
  if (a.length < 6 || b.length < 2) return null;
  return {
    root: a[3]!,
    mountPoint: a[4]!,
    options: a[5]!.split(','),
    fsType: b[0]!,
    source: b[1]!,
  };
}

/** The sandbox's own overlay: one empty read-only tmpfs mounted at /run/secrets, root `/`. */
function isOwnOverlay(m: MountLine): boolean {
  return (
    m.mountPoint === '/run/secrets' &&
    m.root === '/' &&
    m.fsType === 'tmpfs' &&
    m.source === 'tmpfs' &&
    m.options.includes('ro')
  );
}

/** The verdict on the probe's output. Anything not shown to be safe is refused. */
export function secretsVerdict(output: string): SecretsVerdict {
  const lines = output.split(/\r?\n/);
  if (!lines.includes('sandbox-ok')) return 'no-answer';
  const present = lines.includes('secrets=present');
  const absent = lines.includes('secrets=absent');
  if (present === absent) return 'no-answer';
  if (lines.includes('var-secrets=present')) return 'host-mounts';
  const entries = lines.filter((l) => l.startsWith('entry='));
  const mounts = lines.filter((l) => l.startsWith('mount=')).map((l) => parseMountLine(l.slice(6)));
  if (absent) return entries.length === 0 && mounts.length === 0 ? 'ok' : 'host-mounts';
  if (entries.length !== 0 || mounts.length !== 1) return 'host-mounts';
  const only = mounts[0];
  return only && isOwnOverlay(only) ? 'ok' : 'host-mounts';
}
