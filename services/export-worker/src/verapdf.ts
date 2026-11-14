/**
 * PDF validation with veraPDF (09 §3.1, §13; spike S4), run through Podman from the veraPDF
 * project's own image, pinned by digest. The PDF is worker output and therefore hostile, so the
 * validator runs without network and with all capabilities dropped; it receives the file on
 * standard input.
 */
import { podman, podmanMachine } from './container.ts';

/** docker.io/verapdf/cli:v1.30.3, pinned on 2026-11-06 (image built 2026-10-27). */
export const VERAPDF_IMAGE =
  process.env['DOCEDIT_VERAPDF_IMAGE'] ??
  'docker.io/verapdf/cli:v1.30.3@sha256:d74b7026c18a0f171e73c153b617fe6520e1511feb24ca98a348b2bb897669fb';

export type Flavour = 'ua2' | '4' | '4f' | 'ua1';

export interface RuleFailure {
  specification: string;
  clause: string;
  testNumber: number;
  description: string;
  failedChecks: number;
}

export interface Validation {
  flavour: Flavour;
  profile: string;
  compliant: boolean;
  passedChecks: number;
  failedChecks: number;
  failures: RuleFailure[];
  /** Raw validator output when it could not be parsed. */
  error?: string;
}

interface JsonResult {
  profileName?: string;
  compliant?: boolean;
  details?: {
    passedChecks?: number;
    failedChecks?: number;
    ruleSummaries?: Array<{
      specification?: string;
      clause?: string;
      testNumber?: number;
      description?: string;
      failedChecks?: number;
      status?: string;
    }>;
  };
}

/**
 * Set once a run was refused because the pids controller is not delegated (the WSL machine with the
 * systemd cgroup manager, reached through the remote client). Before lane U-EXP-113-123's round 3
 * fix this was inferred from DOCEDIT_PODMAN_MACHINE alone, which the sandbox readiness check set as
 * a side effect; a caller that validated without that check got `controller pids is not available`.
 */
let pidsUnavailable = false;
const PIDS_REFUSED = /controller `?pids`? is not available/;

function veraPdfRun(pdf: Uint8Array, flavour: Flavour) {
  return podman(
    [
      'run',
      '--rm',
      '-i',
      '--network=none',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      // The WSL machine of the spike cannot apply a pids limit with the systemd cgroup manager.
      `--pids-limit=${podmanMachine() || pidsUnavailable ? 0 : 256}`,
      '--entrypoint=sh',
      VERAPDF_IMAGE,
      '-c',
      `cat > /tmp/in.pdf && /opt/verapdf/verapdf --format json --flavour ${flavour} /tmp/in.pdf`,
    ],
    { stdin: pdf, timeoutMs: 300_000, maxStdoutBytes: 32 * 1024 * 1024 },
    true,
  );
}

export async function validatePdf(pdf: Uint8Array, flavour: Flavour): Promise<Validation> {
  let r = await veraPdfRun(pdf, flavour);
  if (r.code !== 0 && !pidsUnavailable && !podmanMachine() && PIDS_REFUSED.test(r.stderr)) {
    // Only the refused pids limit is dropped; network, capabilities and privileges stay as above.
    pidsUnavailable = true;
    r = await veraPdfRun(pdf, flavour);
  }
  const text = new TextDecoder().decode(r.stdout);
  try {
    const j = JSON.parse(text) as {
      report?: { jobs?: Array<{ validationResult?: JsonResult | JsonResult[] }> };
    };
    const vr = j.report?.jobs?.[0]?.validationResult;
    const res = Array.isArray(vr) ? vr[0] : vr;
    if (!res) throw new Error('no validation result');
    const failures: RuleFailure[] = (res.details?.ruleSummaries ?? [])
      .filter((s) => (s.failedChecks ?? 0) > 0 || s.status === 'failed')
      .map((s) => ({
        specification: s.specification ?? '',
        clause: s.clause ?? '',
        testNumber: s.testNumber ?? 0,
        description: s.description ?? '',
        failedChecks: s.failedChecks ?? 0,
      }));
    return {
      flavour,
      profile: res.profileName ?? '',
      compliant: res.compliant === true,
      passedChecks: res.details?.passedChecks ?? 0,
      failedChecks: res.details?.failedChecks ?? 0,
      failures,
    };
  } catch (e) {
    return {
      flavour,
      profile: '',
      compliant: false,
      passedChecks: 0,
      failedChecks: 0,
      failures: [],
      error: `${String(e)}: ${text.slice(0, 2000)} ${r.stderr.slice(0, 2000)}`,
    };
  }
}
