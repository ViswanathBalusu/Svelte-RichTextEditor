/**
 * The development key service: SoftHSM2 in a Podman container (services/signing-service/keyservice,
 * spike S8, owner decision 222). Only the test and the sample script use it. The container is run
 * with the export worker's Podman helper so that one place knows the command line (the command is
 * DOCEDIT_CONTAINER_CLI, default podman).
 */
import { podman, podmanInfo } from '../../../export-worker/src/container.ts';
import { digestInfo, type DigestAlgorithm, type KeyService } from '../../src/keyservice.ts';

// On a Windows or macOS host the remote Podman client has no cgroup controllers delegated (the WSL
// machine of the spikes); runs then ask for --cgroups=disabled. Set DOCEDIT_CONTAINER_CGROUPS to override.
if (podmanInfo()?.remote) process.env['DOCEDIT_CONTAINER_CGROUPS'] ??= 'disabled';

export const KEY_SERVICE_IMAGE =
  process.env['DOCEDIT_KEYSERVICE_IMAGE'] ?? 'localhost/docedit-keyservice-spk021:1';
const SCRIPT = '/usr/local/bin/keyservice.sh';
const CALL_TIMEOUT_MS = 180_000;

/** One running SoftHSM2 container. `stop()` removes it with its token. */
export class SoftHsmKeyService implements KeyService {
  readonly keyLabel = 'seal-key (SoftHSM2 token "seal")';
  readonly container: string;
  private constructor(container: string) {
    this.container = container;
  }

  /**
   * Starts the container. It has no network, a read-only root file system, and tmpfs for the token
   * and its PINs, so nothing of the key outlives it. The key is made inside, at start-up, and is
   * not extractable.
   */
  static async start(name: string): Promise<SoftHsmKeyService> {
    const r = await podman(
      [
        'run',
        '-d',
        '--rm',
        `--name=${name}`,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--tmpfs=/run/keyservice:rw,mode=0700',
        '--tmpfs=/var/lib/softhsm:rw,mode=0700',
        '--tmpfs=/tmp',
        KEY_SERVICE_IMAGE,
      ],
      { timeoutMs: 600_000, maxStdoutBytes: 4096 },
    );
    if (r.code !== 0) throw new Error(`key service did not start: ${r.stderr}`);
    const svc = new SoftHsmKeyService(name);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const l = await podman(['logs', name], { timeoutMs: CALL_TIMEOUT_MS, maxStdoutBytes: 4096 });
      if (new TextDecoder().decode(l.stdout).includes('ready')) return svc;
      if (Date.now() > deadline) {
        await svc.stop();
        throw new Error(`key service not ready: ${l.stderr}`);
      }
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  private async exec(command: string, stdin?: Uint8Array): Promise<Uint8Array> {
    const r = await podman(['exec', '-i', this.container, SCRIPT, command], {
      ...(stdin ? { stdin } : {}),
      timeoutMs: CALL_TIMEOUT_MS,
      maxStdoutBytes: 1024 * 1024,
    });
    if (r.code !== 0) throw new Error(`key service ${command} failed: ${r.stderr}`);
    return r.stdout;
  }

  publicKey(): Promise<Uint8Array> {
    return this.exec('pubkey');
  }

  async signDigest(algorithm: DigestAlgorithm, digest: Uint8Array): Promise<Uint8Array> {
    const sig = await this.exec('sign', digestInfo(algorithm, digest));
    if (sig.length < 256) throw new Error('key service returned a short signature');
    return sig;
  }

  /** The private key's attributes as the token reports them (for the "never leaves" test). */
  async describePrivateKey(): Promise<string> {
    return new TextDecoder().decode(await this.exec('info'));
  }

  /** Tries to read the private key's value out of the token. Returns what came out. */
  async tryExtractPrivateKey(): Promise<string> {
    return new TextDecoder().decode(await this.exec('extract'));
  }

  async stop(): Promise<void> {
    await podman(['kill', this.container], { timeoutMs: 120_000, maxStdoutBytes: 4096 });
  }
}
