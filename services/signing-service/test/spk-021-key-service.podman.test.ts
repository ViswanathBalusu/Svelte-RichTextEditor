/**
 * SPK-021 (spike S8): a tagged LuaLaTeX PDF sealed with a key that is in a key service, and a
 * time-stamp from a local authority. The key service is SoftHSM2 in a Podman container; the sealing
 * code gets the digest to sign into it with `podman exec` and the signature back. Checked by
 * OpenSSL (signatures, time-stamps) and by veraPDF (tagging), not by the code that sealed.
 *
 * Needs: Podman and the image `localhost/docedit-keyservice-spk021:1` (node
 * services/signing-service/scripts/build-keyservice-image.ts), OpenSSL, a local `lualatex` and the
 * local font directory (as the LaTeX tests of the converter), and, for the tagging checks, the
 * veraPDF image the export worker uses. The test skips when the first four are missing.
 * On a Windows or macOS host the remote Podman client has no cgroup controllers delegated; the
 * test then asks for `--cgroups=disabled` (DOCEDIT_CONTAINER_CGROUPS, see container.ts).
 */
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containerCli, podman, podmanInfo } from '../../export-worker/src/container.ts';
import { IMAGE as WORKER_IMAGE } from '../../export-worker/src/sandbox.ts';
import { validatePdf } from '../../export-worker/src/verapdf.ts';
import { addDocumentTimestamp, sealPdf } from '../src/pades.ts';
import { PdfDocument } from '../src/pdf.ts';
import type { DigestAlgorithm, KeyService } from '../src/keyservice.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import { sealOptions, flipByte, startsWith } from './support/world.ts';
import { taggedSample, taggedSampleAvailable } from './support/sample.ts';
import { KEY_SERVICE_IMAGE, SoftHsmKeyService } from './support/softhsm.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { cmsParts, findSignatures, verifyWithOpenssl } from './support/verify.ts';

function imageExists(image: string): boolean {
  const r = spawnSync(containerCli(), ['image', 'exists', image], {
    windowsHide: true,
    timeout: 120_000,
  });
  return !r.error && r.status === 0;
}

const ready =
  podmanInfo() !== null &&
  opensslAvailable() &&
  taggedSampleAvailable() &&
  imageExists(KEY_SERVICE_IMAGE);

/** Wraps the key service and records what the sealing code asks of it. */
class Recording implements KeyService {
  readonly keyLabel: string;
  readonly signCalls: { algorithm: DigestAlgorithm; length: number }[] = [];
  private readonly inner: KeyService;
  constructor(inner: KeyService) {
    this.inner = inner;
    this.keyLabel = inner.keyLabel;
  }
  publicKey(): Promise<Uint8Array> {
    return this.inner.publicKey();
  }
  signDigest(algorithm: DigestAlgorithm, digest: Uint8Array): Promise<Uint8Array> {
    this.signCalls.push({ algorithm, length: digest.length });
    return this.inner.signDigest(algorithm, digest);
  }
}

describe.skipIf(!ready)('SPK-021: seal a tagged LuaLaTeX PDF with a key in a key service', () => {
  let hsm: SoftHsmKeyService;
  let ks: Recording;
  let pki: TestPki;
  let tsa: TestTsa;
  let sample: Uint8Array;
  let b_lt: Uint8Array;
  let b_lta: Uint8Array;

  beforeAll(async () => {
    sample = await taggedSample();
    hsm = await SoftHsmKeyService.start(`docedit-spk021-ks-${process.pid}`);
    ks = new Recording(hsm);
    pki = makePki(await ks.publicKey());
    tsa = await startTestTsa(pki);
    b_lt = (await sealPdf(sample, sealOptions(pki, tsa, ks, 'B-LT'))).pdf;
    b_lta = await addDocumentTimestamp(b_lt, {
      timestamps: sealOptions(pki, tsa, ks, 'B-LT').timestamps,
    });
  }, 900_000);

  afterAll(async () => {
    await tsa?.stop();
    pki?.remove();
    await hsm?.stop();
  }, 300_000);

  it('the sample is a tagged PDF 2.0 and the sealed file starts with its bytes', () => {
    const text = Buffer.from(sample).toString('latin1');
    expect(text.startsWith('%PDF-2.0')).toBe(true);
    expect(text).toContain('/StructTreeRoot');
    // LuaTeX writes a cross-reference stream and object streams; the classic-table case is in
    // spk-021-seal.test.ts.
    expect(new PdfDocument(sample).kind).toBe('stream');
    expect(startsWith(b_lt, sample)).toBe(true);
    expect(startsWith(b_lta, b_lt)).toBe(true);
  });

  it('criterion 1: the seal and its time-stamp verify with OpenSSL (B-LT, then B-LTA)', () => {
    for (const pdf of [b_lt, b_lta]) {
      for (const rep of verifyWithOpenssl(pdf, pki)) {
        expect(rep.main.ok, rep.main.detail).toBe(true);
        if (rep.signature.kind === 'signature') {
          expect(rep.timestamp?.ok, rep.timestamp?.detail).toBe(true);
          expect(rep.signature.subFilter).toBe('ETSI.CAdES.detached');
        }
      }
    }
    // One time-stamp for the signature, one for the document time-stamp.
    expect(tsa.count()).toBe(2);
  }, 180_000);

  it('criterion 2: the profile is B-LT, and B-LTA is an append', () => {
    const lt = findSignatures(b_lt);
    expect(lt).toHaveLength(1);
    expect(Buffer.from(b_lt).toString('latin1')).toContain('/Type /DSS');
    expect(findSignatures(b_lta).map((s) => s.kind)).toEqual(['signature', 'document-time-stamp']);
    expect(cmsParts(lt[0]!.contents).token).not.toBeNull();
  });

  it('one changed byte anywhere in the sealed file is reported by the validators', () => {
    // In the part the signature covers (inside the page tree's compressed data, near the middle).
    const sig = findSignatures(b_lt)[0]!;
    const inCovered = Math.floor((sig.byteRange[1] as number) / 2);
    expect(verifyWithOpenssl(flipByte(b_lt, inCovered), pki)[0]!.main.ok).toBe(false);
    // In the first byte of the file.
    expect(verifyWithOpenssl(flipByte(b_lt, 0), pki)[0]!.main.ok).toBe(false);
    // Appending a byte after the signature's range does not break it: it is the increment that
    // long-term validation uses. The next signature or time-stamp, if any, would fail.
    const appended = new Uint8Array(b_lt.length + 1);
    appended.set(b_lt);
    expect(verifyWithOpenssl(appended, pki)[0]!.main.ok).toBe(true);
    const lta = findSignatures(b_lta)[1]!;
    // In the part the document time-stamp covers: it fails, and so does the signature it covers.
    const bad = verifyWithOpenssl(
      flipByte(b_lta, Math.floor((lta.byteRange[1] as number) / 2)),
      pki,
    );
    expect(bad.map((r) => r.main.ok)).toEqual([false, false]);
  }, 180_000);

  it('criterion 3: only 32-byte digests went to the key service', () => {
    expect(ks.signCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of ks.signCalls) expect(c).toEqual({ algorithm: 'SHA-256', length: 32 });
  });

  it('criterion 3: the token reports the private key as sensitive and never extractable', async () => {
    const info = await hsm.describePrivateKey();
    expect(info).toMatch(/Access:\s+sensitive, always sensitive, never extractable/);
    expect(await hsm.tryExtractPrivateKey()).not.toContain('LEAKED');
  }, 180_000);

  it('criterion 3: the key service image holds no token, the container no network', async () => {
    const r = await podman(
      [
        'run',
        '--rm',
        '--network=none',
        '--entrypoint=sh',
        KEY_SERVICE_IMAGE,
        '-c',
        'ls -A /var/lib/softhsm/tokens 2>/dev/null | wc -l',
      ],
      { timeoutMs: 600_000, maxStdoutBytes: 4096 },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe('0');
    const net = await podman(
      ['inspect', '--format', '{{.HostConfig.NetworkMode}}', hsm.container],
      { timeoutMs: 120_000, maxStdoutBytes: 4096 },
      true,
    );
    expect(new TextDecoder().decode(net.stdout).trim()).toBe('none');
  }, 900_000);

  it.skipIf(!imageExists(WORKER_IMAGE))(
    'criterion 3: the compile worker image has no key service tool and no key file',
    async () => {
      const r = await podman(
        [
          'run',
          '--rm',
          '--network=none',
          '--entrypoint=sh',
          WORKER_IMAGE,
          '-c',
          'for p in softhsm2-util pkcs11-tool; do command -v $p; done; ' +
            'find /etc /opt /root /home /srv /usr/local /var/lib -xdev ' +
            '\\( -iname "*softhsm*" -o -name "*.p12" -o -name "*.pfx" -o -name "*.key" \\) 2>/dev/null; ' +
            'grep -rIl -e "-----BEGIN [A-Z ]*PRIVATE KEY" /etc /opt /root /home /srv /usr/local /var/lib 2>/dev/null; ' +
            'echo end',
        ],
        { timeoutMs: 600_000, maxStdoutBytes: 65_536 },
      );
      expect(r.code, r.stderr).toBe(0);
      // Nothing is listed before the closing line.
      expect(new TextDecoder().decode(r.stdout).trim()).toBe('end');
    },
    900_000,
  );

  it('criterion 3: the sealed files carry no private key block', () => {
    for (const pdf of [b_lt, b_lta])
      expect(Buffer.from(pdf).toString('latin1')).not.toMatch(/PRIVATE KEY/);
  });

  it('criterion 4: the sealed PDF still validates with veraPDF, as PDF/UA-2 and as PDF/A-4f', async () => {
    // One run after the other: the validator runs in a container each time.
    const check = async (pdf: Uint8Array, flavour: 'ua2' | '4f'): Promise<void> => {
      const v = await validatePdf(pdf, flavour);
      expect(v.compliant, `${flavour}: ${JSON.stringify(v.failures)} ${v.error ?? ''}`).toBe(true);
    };
    await check(sample, 'ua2');
    await check(sample, '4f');
    for (const pdf of [b_lt, b_lta]) {
      await check(pdf, 'ua2');
      await check(pdf, '4f');
    }
  }, 1_800_000);
});
