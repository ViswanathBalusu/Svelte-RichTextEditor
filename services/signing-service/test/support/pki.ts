/**
 * A self-signed test certificate chain, made with the OpenSSL command line (spike S8; owner
 * decision 223). Root CA, an intermediate "sealing CA", the sealing certificate (its public key is
 * the one in the key service; the private key is never here), and a time-stamp authority
 * certificate with the `timeStamping` extended key usage. CRLs are made for both CAs.
 *
 * Nothing here is a trust anchor for anything but these tests. The CA private keys are in a
 * temporary directory and are removed with it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OPENSSL = process.env['DOCEDIT_OPENSSL'] ?? 'openssl';
const fwd = (p: string): string => p.replace(/\\/g, '/');

export function opensslAvailable(): boolean {
  const r = spawnSync(OPENSSL, ['version'], { encoding: 'utf8', windowsHide: true });
  return !r.error && r.status === 0;
}

export function openssl(dir: string, args: readonly string[], input?: Uint8Array): Buffer {
  const r = spawnSync(OPENSSL, args, {
    cwd: dir,
    ...(input ? { input: Buffer.from(input) } : {}),
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `openssl ${args.slice(0, 3).join(' ')} failed: ${String(r.error ?? '')}${r.stderr?.toString('utf8') ?? ''}`,
    );
  return r.stdout;
}

const EXT = `
[v3_root]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash

[v3_inter]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
crlDistributionPoints = URI:http://crl.test.invalid/root.crl

[v3_seal]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation
extendedKeyUsage = 1.3.6.1.5.5.7.3.36
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
crlDistributionPoints = URI:http://crl.test.invalid/inter.crl

[v3_tsa]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
crlDistributionPoints = URI:http://crl.test.invalid/inter.crl
`;

const CA_CNF = (name: string, dirFwd: string): string => `
[ca]
default_ca = CA_default
[CA_default]
database = ${dirFwd}/${name}.index
crlnumber = ${dirFwd}/${name}.crlnumber
default_md = sha256
default_crl_days = 3650
`;

export interface TestPki {
  dir: string;
  rootPem: string;
  /** DER certificates. */
  root: Uint8Array;
  intermediate: Uint8Array;
  seal: Uint8Array;
  tsa: Uint8Array;
  /** DER CRLs: the root's (covers the intermediate) and the intermediate's (covers the rest). */
  rootCrl: Uint8Array;
  intermediateCrl: Uint8Array;
  /** The files the time-stamp authority needs (see tsa.ts). */
  tsaDir: string;
  remove(): void;
}

/**
 * Makes the chain. `sealPublicKeyDer` is the DER SubjectPublicKeyInfo from the key service; the
 * sealing certificate is issued for that key without the private key ever being seen.
 */
export function makePki(sealPublicKeyDer: Uint8Array): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-spk021-pki-'));
  const d = fwd(dir);
  writeFileSync(join(dir, 'ext.cnf'), EXT);
  writeFileSync(
    join(dir, 'req.cnf'),
    '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = x\n' + EXT,
  );
  writeFileSync(join(dir, 'root.cnf'), CA_CNF('root', d));
  writeFileSync(join(dir, 'inter.cnf'), CA_CNF('inter', d));
  for (const n of ['root', 'inter']) {
    writeFileSync(join(dir, `${n}.index`), '');
    writeFileSync(join(dir, `${n}.crlnumber`), '01\n');
  }
  const O = '/O=DocEdit test only (SPK-021)';
  openssl(dir, ['genrsa', '-out', 'root.key', '2048']);
  openssl(dir, [
    'req',
    '-new',
    '-x509',
    '-config',
    'req.cnf',
    '-key',
    'root.key',
    '-sha256',
    '-days',
    '3650',
    '-subj',
    `${O}/CN=DocEdit Test Root CA`,
    '-extensions',
    'v3_root',
    '-out',
    'root.crt',
  ]);
  openssl(dir, ['genrsa', '-out', 'inter.key', '2048']);
  openssl(dir, [
    'req',
    '-new',
    '-config',
    'req.cnf',
    '-key',
    'inter.key',
    '-subj',
    `${O}/CN=DocEdit Test Sealing CA`,
    '-out',
    'inter.csr',
  ]);
  const issue = (
    csrOrPub: readonly string[],
    ca: string,
    serial: number,
    ext: string,
    days: number,
    out: string,
  ): void => {
    openssl(dir, [
      ...csrOrPub,
      '-CA',
      `${ca}.crt`,
      '-CAkey',
      `${ca}.key`,
      '-set_serial',
      String(serial),
      '-days',
      String(days),
      '-sha256',
      '-extfile',
      'ext.cnf',
      '-extensions',
      ext,
      '-out',
      out,
    ]);
  };
  issue(['x509', '-req', '-in', 'inter.csr'], 'root', 2, 'v3_inter', 3650, 'inter.crt');

  writeFileSync(join(dir, 'seal.pub.der'), sealPublicKeyDer);
  openssl(dir, ['pkey', '-pubin', '-inform', 'DER', '-in', 'seal.pub.der', '-out', 'seal.pub.pem']);
  issue(
    [
      'x509',
      '-new',
      '-force_pubkey',
      'seal.pub.pem',
      '-subj',
      `${O}/CN=DocEdit Test Seal (SPK-021)`,
    ],
    'inter',
    3,
    'v3_seal',
    825,
    'seal.crt',
  );

  openssl(dir, ['genrsa', '-out', 'tsa.key', '2048']);
  openssl(dir, [
    'req',
    '-new',
    '-config',
    'req.cnf',
    '-key',
    'tsa.key',
    '-subj',
    `${O}/CN=DocEdit Test Time-Stamp Authority`,
    '-out',
    'tsa.csr',
  ]);
  issue(['x509', '-req', '-in', 'tsa.csr'], 'inter', 4, 'v3_tsa', 825, 'tsa.crt');

  openssl(dir, [
    'ca',
    '-config',
    'root.cnf',
    '-gencrl',
    '-cert',
    'root.crt',
    '-keyfile',
    'root.key',
    '-out',
    'root.crl',
  ]);
  openssl(dir, [
    'ca',
    '-config',
    'inter.cnf',
    '-gencrl',
    '-cert',
    'inter.crt',
    '-keyfile',
    'inter.key',
    '-out',
    'inter.crl',
  ]);

  const der = (pem: string, kind: 'x509' | 'crl'): Uint8Array =>
    new Uint8Array(openssl(dir, [kind, '-in', pem, '-outform', 'DER']));
  // The chain the authority puts in its tokens.
  writeFileSync(
    join(dir, 'tsa-chain.pem'),
    readFileSync(join(dir, 'inter.crt'), 'utf8') + readFileSync(join(dir, 'root.crt'), 'utf8'),
  );
  mkdirSync(join(dir, 'tsa'), { recursive: true });
  return {
    dir,
    rootPem: join(dir, 'root.crt'),
    root: der('root.crt', 'x509'),
    intermediate: der('inter.crt', 'x509'),
    seal: der('seal.crt', 'x509'),
    tsa: der('tsa.crt', 'x509'),
    rootCrl: der('root.crl', 'crl'),
    intermediateCrl: der('inter.crl', 'crl'),
    tsaDir: dir,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
