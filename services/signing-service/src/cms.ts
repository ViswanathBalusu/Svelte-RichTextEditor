/**
 * CMS (CAdES) signature building with a remote signer, and RFC 3161 time-stamp requests (spike S8).
 *
 * The signed attributes are built here, hashed here, and only the hash goes to the key service.
 * `pkijs` supplies the ASN.1 structures; its own `sign` call is not used, because it needs a
 * private key object in this process, which is what the design forbids.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import type { KeyService } from './keyservice.ts';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signatureTimeStampToken: '1.2.840.113549.1.9.16.2.14',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
} as const;

type Asn1 = ReturnType<typeof asn1js.fromBER>['result'];

const sha256 = (b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(b).digest());
const toBuffer = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function parseDer(der: Uint8Array): Asn1 {
  const r = asn1js.fromBER(toBuffer(der));
  if (r.offset === -1) throw new Error('not valid DER');
  return r.result;
}

export function certificateOf(der: Uint8Array): pkijs.Certificate {
  return new pkijs.Certificate({ schema: parseDer(der) });
}

export interface TimestampSource {
  /** Returns an RFC 3161 time-stamp token (a CMS `ContentInfo`, DER) over the SHA-256 `digest`. */
  stamp(digest: Uint8Array): Promise<Uint8Array>;
}

/** An RFC 3161 client for one authority URL (HTTP, `application/timestamp-query`). */
export class HttpTimestampAuthority implements TimestampSource {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  async stamp(digest: Uint8Array): Promise<Uint8Array> {
    const nonce = randomBytes(8);
    nonce[0] = (nonce[0] as number) & 0x7f;
    const req = new pkijs.TimeStampReq({
      version: 1,
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({
          algorithmId: OID.sha256,
          algorithmParams: new asn1js.Null(),
        }),
        hashedMessage: new asn1js.OctetString({ valueHex: toBuffer(digest) }),
      }),
      nonce: new asn1js.Integer({ valueHex: toBuffer(nonce) }),
      certReq: true,
    });
    const body = new Uint8Array(req.toSchema().toBER());
    const post = (): Promise<Response> =>
      fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/timestamp-query' },
        body,
      });
    // A connection that the authority closed while it sat idle is retried once with a new one.
    const res = await post().catch(() => post());
    if (!res.ok) throw new Error(`time-stamp authority answered ${res.status}`);
    const answer = new Uint8Array(await res.arrayBuffer());
    const resp = new pkijs.TimeStampResp({ schema: parseDer(answer) });
    const status = resp.status.status;
    if (status !== 0 && status !== 1) throw new Error(`time-stamp refused: status ${status}`);
    if (!resp.timeStampToken) throw new Error('time-stamp response has no token');
    const token = new Uint8Array(resp.timeStampToken.toSchema().toBER());
    // The token must stamp this digest. A mismatch would be an authority error or a swap.
    const info = timestampInfo(token);
    if (Buffer.compare(Buffer.from(info.imprint), Buffer.from(digest)) !== 0)
      throw new Error('time-stamp imprint does not match the digest sent');
    return token;
  }
}

export interface TimestampInfo {
  imprint: Uint8Array;
  genTime: Date;
  policy: string;
  serial: string;
  /** The certificates the authority put in the token (DER). */
  certificates: Uint8Array[];
}

/** Reads the `TSTInfo` and certificates of a token. It does not verify the token. */
export function timestampInfo(token: Uint8Array): TimestampInfo {
  const ci = new pkijs.ContentInfo({ schema: parseDer(token) });
  const sd = new pkijs.SignedData({ schema: ci.content });
  const eContent = sd.encapContentInfo.eContent;
  if (!eContent) throw new Error('token has no TSTInfo');
  const inner = eContent.valueBlock.valueHexView;
  const tst = new pkijs.TSTInfo({ schema: parseDer(new Uint8Array(inner)) });
  return {
    imprint: new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView),
    genTime: tst.genTime,
    policy: tst.policy,
    serial: Buffer.from(tst.serialNumber.valueBlock.valueHexView).toString('hex'),
    certificates: (sd.certificates ?? [])
      .filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate)
      .map((c) => new Uint8Array(c.toSchema().toBER())),
  };
}

/** The signature time-stamp token (DER) in the unsigned attributes of a CMS, or null. */
export function cmsSignatureToken(cms: Uint8Array): Uint8Array | null {
  const ci = new pkijs.ContentInfo({ schema: parseDer(cms) });
  const sd = new pkijs.SignedData({ schema: ci.content });
  const attr = sd.signerInfos[0]?.unsignedAttrs?.attributes.find(
    (a) => a.type === OID.signatureTimeStampToken,
  );
  const value = attr?.values[0];
  return value ? new Uint8Array(value.toBER()) : null;
}

export interface CmsOptions {
  keyService: KeyService;
  /** The signing certificate (DER), then its issuers up to but not including the root. */
  chain: readonly Uint8Array[];
  /** SHA-256 of the signed byte ranges of the PDF. */
  contentDigest: Uint8Array;
  /** When given, a signature time-stamp (RFC 3161) goes in as an unsigned attribute. */
  timestamps?: TimestampSource;
}

/**
 * A detached CAdES-B-B signature (or B-T with `timestamps`) over a digest, for the `/Contents` of
 * a PAdES signature (ETSI EN 319 142-1). Attributes: content-type, message-digest and
 * signing-certificate-v2. No signing-time attribute: PAdES carries the time in `/M`.
 */
export async function buildCms(opts: CmsOptions): Promise<Uint8Array> {
  const signerDer = opts.chain[0];
  if (!signerDer) throw new Error('no signing certificate');
  const signer = certificateOf(signerDer);
  const attr = (type: string, value: Asn1): pkijs.Attribute =>
    new pkijs.Attribute({ type, values: [value] });

  const essCertId = new asn1js.Sequence({
    value: [new asn1js.OctetString({ valueHex: toBuffer(sha256(signerDer)) })],
  });
  const attributes = [
    attr(OID.contentType, new asn1js.ObjectIdentifier({ value: OID.data })),
    attr(OID.messageDigest, new asn1js.OctetString({ valueHex: toBuffer(opts.contentDigest) })),
    attr(
      OID.signingCertificateV2,
      new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertId] })] }),
    ),
  ];
  // DER wants a SET OF in order of encoding. The bytes that are signed and the bytes that are
  // written must be the same, so the order is fixed here.
  attributes.sort((a, b) =>
    Buffer.compare(Buffer.from(a.toSchema().toBER()), Buffer.from(b.toSchema().toBER())),
  );
  const signedSet = new asn1js.Set({ value: attributes.map((a) => a.toSchema()) });
  const toBeSigned = sha256(new Uint8Array(signedSet.toBER()));
  const signature = await opts.keyService.signDigest('SHA-256', toBeSigned);

  const digestAlg = new pkijs.AlgorithmIdentifier({
    algorithmId: OID.sha256,
    algorithmParams: new asn1js.Null(),
  });
  const unsigned: pkijs.Attribute[] = [];
  if (opts.timestamps) {
    // RFC 3161 time-stamp over the signature value (CAdES signature-time-stamp, ETSI EN 319 122-1).
    const token = await opts.timestamps.stamp(sha256(signature));
    unsigned.push(attr(OID.signatureTimeStampToken, parseDer(token)));
  }
  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({
      issuer: signer.issuer,
      serialNumber: signer.serialNumber,
    }),
    digestAlgorithm: digestAlg,
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: OID.sha256WithRsa,
      algorithmParams: new asn1js.Null(),
    }),
    signature: new asn1js.OctetString({ valueHex: toBuffer(signature) }),
    ...(unsigned.length
      ? { unsignedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 1, attributes: unsigned }) }
      : {}),
  });
  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [digestAlg],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: opts.chain.map(certificateOf),
    signerInfos: [signerInfo],
  });
  const ci = new pkijs.ContentInfo({
    contentType: OID.signedData,
    content: signedData.toSchema(true),
  });
  return new Uint8Array(ci.toSchema().toBER());
}
