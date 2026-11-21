/**
 * The HTTP transport of the signing service (FRW-052). One route:
 *
 *     POST /v1/seal
 *     Authorization: Bearer <the document service's credential>
 *     {"tenant", "documentId", "seq", "pdfSha256", "compileSha256": [a, b], "seal"?, "pdf": base64}
 *
 * It answers 200 with `{"ok": true, "pdf": base64, "sealedSha256", "profile", "timestamped": true,
 * "timestampTime", "sealedAt", "keyId", "keyOwner"}`, or an error status with `{"ok": false,
 * "code", "retryable"}`. `GET /healthz` answers 200 and touches nothing else.
 *
 *     POST /v1/anchor     (FRW-054 criterion 3)
 *     {"tenant", "documentId", "workflow", "seq", "chainHead"}
 *
 * signs and time-stamps a chain head: 200 with `{"ok": true, "record", "recordSha256", "cms": base64,
 * "timestampTime", "anchoredAt", "keyId", "keyOwner"}`; the failures are those of `/v1/seal`.
 *
 *     POST /v1/extend     (FRW-056)
 *     {"tenant", "documentId", "seq", "pdf": base64, "pdfSha256", "idempotencyKey", "validation": boolean}
 *
 * appends fresh validation data (when `validation`) and a further document time-stamp as incremental
 * updates: 200 with `{"ok": true, "pdf": base64, "sealedSha256", "timestampTime", "extendedAt",
 * "expiresAtMs", "validationAdded"}`; the failures are those of `/v1/seal`. No other
 * route exists.
 *
 * Nothing of a request is logged here: not the body, not the credential. The audit log of the
 * service (`audit.ts`) holds the identifiers and hashes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  AnchorCommand,
  AppearanceRequest,
  ExtendCommand,
  SealCommand,
  SealFailureCode,
  SigningService,
} from './service.ts';

export interface HttpOptions {
  /** The largest request body accepted, in bytes. The specification gives no figure. */
  readonly maxBodyBytes: number;
}

const STATUS: Readonly<Record<SealFailureCode, number>> = {
  unauthenticated: 401,
  wrong_caller: 403,
  rate_limited: 429,
  bad_request: 400,
  hash_mismatch: 422,
  pair_differs: 422,
  binding_conflict: 409,
  unknown_seal_level: 422,
  no_key: 503,
  signing_unavailable: 503,
  tsa_unreachable: 503,
  audit_unavailable: 503,
  seal_failed: 422,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(h);
  return m?.[1] ?? null;
}

/** The appearance request of a seal, or null when it is not of the shape. */
function parseAppearances(raw: unknown): AppearanceRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const layout = o['layout'];
  const targets = o['targets'];
  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) return null;
  if (!Array.isArray(targets)) return null;
  const list: AppearanceRequest['targets'][number][] = [];
  for (const t of targets) {
    if (typeof t !== 'object' || t === null) return null;
    const x = t as Record<string, unknown>;
    if (
      typeof x['id'] !== 'string' ||
      typeof x['key'] !== 'string' ||
      typeof x['kind'] !== 'string' ||
      !Array.isArray(x['lines']) ||
      !x['lines'].every((l) => typeof l === 'string')
    )
      return null;
    list.push({ id: x['id'], key: x['key'], kind: x['kind'], lines: x['lines'] as string[] });
  }
  return { layout: layout as Record<string, unknown>, targets: list };
}

function parseCommand(raw: unknown): SealCommand | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const pair = o['compileSha256'];
  if (
    typeof o['tenant'] !== 'string' ||
    typeof o['documentId'] !== 'string' ||
    typeof o['seq'] !== 'number' ||
    typeof o['pdfSha256'] !== 'string' ||
    typeof o['pdf'] !== 'string' ||
    !Array.isArray(pair) ||
    pair.length !== 2 ||
    typeof pair[0] !== 'string' ||
    typeof pair[1] !== 'string' ||
    (o['seal'] !== undefined && typeof o['seal'] !== 'string')
  )
    return null;
  const appearances =
    o['appearances'] === undefined ? undefined : parseAppearances(o['appearances']);
  if (appearances === null) return null;
  return {
    ...(appearances !== undefined ? { appearances } : {}),
    tenant: o['tenant'],
    documentId: o['documentId'],
    seq: o['seq'],
    pdfSha256: o['pdfSha256'],
    compileSha256: [pair[0], pair[1]],
    pdf: new Uint8Array(Buffer.from(o['pdf'], 'base64')),
    ...(o['seal'] !== undefined ? { seal: o['seal'] } : {}),
  };
}

function parseAnchor(raw: unknown): AnchorCommand | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o['tenant'] !== 'string' ||
    typeof o['documentId'] !== 'string' ||
    typeof o['workflow'] !== 'string' ||
    typeof o['seq'] !== 'number' ||
    typeof o['chainHead'] !== 'string'
  )
    return null;
  return {
    tenant: o['tenant'],
    documentId: o['documentId'],
    workflow: o['workflow'],
    seq: o['seq'],
    chainHead: o['chainHead'],
  };
}

/** `POST /v1/anchor`: signs and time-stamps a chain head (FRW-054 criterion 3). */
async function anchorRoute(
  service: SigningService,
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  const body = await readBody(req, maxBodyBytes);
  if (body === null) return send(res, 413, { ok: false, code: 'too_large', retryable: false });
  let cmd: AnchorCommand | null;
  try {
    cmd = parseAnchor(JSON.parse(body.toString('utf8')));
  } catch {
    cmd = null;
  }
  // A body that is not a request is refused as `bad_request` after the credential is checked.
  const out = await service.anchor(
    bearer(req),
    cmd ?? { tenant: '', documentId: '', workflow: '', seq: -1, chainHead: '' },
  );
  if (!out.ok)
    return send(res, STATUS[out.code], { ok: false, code: out.code, retryable: out.retryable });
  return send(res, 200, {
    ok: true,
    record: out.record,
    recordSha256: out.recordSha256,
    cms: Buffer.from(out.cms).toString('base64'),
    timestampTime: out.timestampTime.toISOString(),
    anchoredAt: out.anchoredAt.toISOString(),
    keyId: out.keyId,
    keyOwner: out.keyOwner,
  });
}

function parseExtend(raw: unknown): ExtendCommand | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o['tenant'] !== 'string' ||
    typeof o['documentId'] !== 'string' ||
    typeof o['seq'] !== 'number' ||
    typeof o['pdfSha256'] !== 'string' ||
    typeof o['pdf'] !== 'string' ||
    typeof o['idempotencyKey'] !== 'string' ||
    typeof o['validation'] !== 'boolean'
  )
    return null;
  return {
    tenant: o['tenant'],
    documentId: o['documentId'],
    seq: o['seq'],
    pdfSha256: o['pdfSha256'],
    pdf: new Uint8Array(Buffer.from(o['pdf'], 'base64')),
    idempotencyKey: o['idempotencyKey'],
    validation: o['validation'],
  };
}

/** `POST /v1/extend`: long-term validation data and a renewed time-stamp (FRW-056). */
async function extendRoute(
  service: SigningService,
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  const body = await readBody(req, maxBodyBytes);
  if (body === null) return send(res, 413, { ok: false, code: 'too_large', retryable: false });
  let cmd: ExtendCommand | null;
  try {
    cmd = parseExtend(JSON.parse(body.toString('utf8')));
  } catch {
    cmd = null;
  }
  const out = await service.extend(
    bearer(req),
    cmd ?? {
      tenant: '',
      documentId: '',
      seq: -1,
      pdf: new Uint8Array(),
      pdfSha256: '',
      idempotencyKey: '',
      validation: false,
    },
  );
  if (!out.ok)
    return send(res, STATUS[out.code], { ok: false, code: out.code, retryable: out.retryable });
  return send(res, 200, {
    ok: true,
    pdf: Buffer.from(out.pdf).toString('base64'),
    sealedSha256: out.sealedSha256,
    timestampTime: out.timestampTime.toISOString(),
    extendedAt: out.extendedAt.toISOString(),
    expiresAtMs: out.expiresAtMs,
    validationAdded: out.validationAdded,
  });
}

export function createSigningServer(service: SigningService, opts: HttpOptions): Server {
  return createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'POST' && path === '/v1/anchor')
        return anchorRoute(service, req, res, opts.maxBodyBytes);
      if (req.method === 'POST' && path === '/v1/extend')
        return extendRoute(service, req, res, opts.maxBodyBytes);
      if (req.method !== 'POST' || path !== '/v1/seal')
        return send(res, 404, { ok: false, code: 'not_found', retryable: false });
      const body = await readBody(req, opts.maxBodyBytes);
      if (body === null) return send(res, 413, { ok: false, code: 'too_large', retryable: false });
      let cmd: SealCommand | null;
      try {
        cmd = parseCommand(JSON.parse(body.toString('utf8')));
      } catch {
        cmd = null;
      }
      if (cmd === null) {
        // Still counted and audited as a refusal when the credential is good: hand the service an
        // empty command, which it refuses as `bad_request`.
        const out = await service.seal(bearer(req), {
          tenant: '',
          documentId: '',
          seq: -1,
          pdfSha256: '',
          compileSha256: ['', ''],
          pdf: new Uint8Array(),
        });
        const code: SealFailureCode = out.ok ? 'bad_request' : out.code;
        return send(res, STATUS[code], { ok: false, code, retryable: false });
      }
      const out = await service.seal(bearer(req), cmd);
      if (!out.ok)
        return send(res, STATUS[out.code], { ok: false, code: out.code, retryable: out.retryable });
      return send(res, 200, {
        ok: true,
        pdf: Buffer.from(out.pdf).toString('base64'),
        sealedSha256: out.sealedSha256,
        profile: out.profile,
        timestamped: true,
        timestampTime: out.timestampTime.toISOString(),
        sealedAt: out.sealedAt.toISOString(),
        keyId: out.keyId,
        keyOwner: out.keyOwner,
        ...(out.appearances ? { appearances: out.appearances } : {}),
      });
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { ok: false, code: 'seal_failed', retryable: false });
      else res.end();
    });
  });
}
