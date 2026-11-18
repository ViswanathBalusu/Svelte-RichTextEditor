/**
 * Makes the sealed sample PDFs for the Acrobat check of spike S8 (SPK-021):
 *
 *   node services/signing-service/scripts/make-sample.ts [output folder]
 *
 * Output (default docs/spikes/2026-11-18-s8-sealing/): the tagged LuaLaTeX sample, the same file
 * sealed at B-LT and at B-LTA, and the test root certificate to put in Acrobat's trusted
 * certificates for the check. The key is made in the SoftHSM2 container for this run and goes
 * away with it; the CA keys are in a temporary folder that is removed. Both certificates and the
 * time-stamp authority are test ones (owner decision 223): Acrobat shows the seal as untrusted
 * until the root is trusted by hand.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocumentTimestamp, sealPdf } from '../src/pades.ts';
import { makePki } from '../test/support/pki.ts';
import { taggedSample } from '../test/support/sample.ts';
import { SoftHsmKeyService } from '../test/support/softhsm.ts';
import { startTestTsa } from '../test/support/tsa.ts';
import { findSignatures, verifyWithOpenssl } from '../test/support/verify.ts';
import { sealOptions } from '../test/support/world.ts';

const out =
  process.argv[2] ??
  fileURLToPath(new URL('../../../docs/spikes/2026-11-18-s8-sealing/', import.meta.url));
mkdirSync(out, { recursive: true });

const hsm = await SoftHsmKeyService.start(`docedit-spk021-sample-${process.pid}`);
let pki;
let tsa;
try {
  const sample = await taggedSample();
  pki = makePki(await hsm.publicKey());
  tsa = await startTestTsa(pki);
  const opts = sealOptions(pki, tsa, hsm, 'B-LT');
  const t0 = performance.now();
  const lt = await sealPdf(sample, opts);
  const t1 = performance.now();
  const lta = await addDocumentTimestamp(lt.pdf, { timestamps: opts.timestamps });
  const t2 = performance.now();
  console.log(
    `sealed at B-LT in ${Math.round(t1 - t0)} ms (one key service call by podman exec, one ` +
      `time-stamp request), document time-stamp added in ${Math.round(t2 - t1)} ms; ` +
      `sample ${sample.length} bytes`,
  );
  writeFileSync(join(out, 'sample-unsealed.pdf'), sample);
  writeFileSync(join(out, 'sample-sealed-b-lt.pdf'), lt.pdf);
  writeFileSync(join(out, 'sample-sealed-b-lta.pdf'), lta);
  writeFileSync(join(out, 'test-root-ca.cer'), pki.root);
  console.log(`CMS of the signature: ${lt.cmsBytes} bytes`);
  for (const [n, pdf] of [
    ['B-LT', lt.pdf],
    ['B-LTA', lta],
  ] as const) {
    const reports = verifyWithOpenssl(pdf, pki);
    console.log(
      `${n}: ${pdf.length} bytes, ${findSignatures(pdf).length} signature objects, OpenSSL: ` +
        reports
          .map(
            (r) =>
              `${r.signature.kind} ${r.main.ok && (r.timestamp?.ok ?? true) ? 'ok' : 'FAILED'}`,
          )
          .join(', '),
    );
  }
} finally {
  await tsa?.stop();
  pki?.remove();
  await hsm.stop();
}
