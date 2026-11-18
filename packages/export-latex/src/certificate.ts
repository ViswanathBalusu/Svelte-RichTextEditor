/**
 * The certificate of completion (12 §8.2 step 1; 09 §4, §9.1; FRW-050; EXP-080 merged into it).
 *
 * The certificate is made of CDM blocks appended after the body of the document: a first paragraph
 * that starts a new page, then paragraphs with the identifiers, the sequence numbers, the chain
 * head and each participant's events. It goes through the same converter as the body, so every
 * string reaches TeX through the typed emitters of 09 §4 (`text`, and nothing else) and none is
 * interpolated: a participant name or an evidence string that holds TeX control sequences or markup
 * is printed as the characters it is. The body's blocks are not touched, and the certificate starts
 * on a new page, so the pagination of the body does not change.
 *
 * `CertificateFacts` is plain data. The service builds it from the evidence (`buildCertificateFacts`
 * of @docedit/authority, whose result has this shape) and sends it with the job; nothing here reads
 * a stored row. With `networkIdentityIncluded` false the address and the user agent are not printed,
 * whatever the events hold. The wording of the fixed sentences is the authority's
 * (`CERTIFICATE_STATEMENT`, FRW-058) and comes in `statement`.
 */
type J = Record<string, unknown>;

/** The event kinds a certificate lists (12 §7). */
export type CertificateEventKind = 'viewed' | 'consent' | 'signed' | 'completed' | 'declined';

export interface CertificateEvent {
  readonly kind: CertificateEventKind;
  readonly serverTimeMs: number;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface CertificateParticipant {
  readonly id: string;
  readonly label: string;
  readonly events: readonly CertificateEvent[];
}

export interface CertificateFacts {
  readonly documentId: string;
  readonly workflowId: string;
  readonly sentSeq: number;
  readonly completedSeq: number;
  /** Lower-case hexadecimal SHA-256. */
  readonly chainHeadHash: string;
  readonly participants: readonly CertificateParticipant[];
  readonly networkIdentityIncluded: boolean;
  readonly statement: readonly string[];
}

const EVENT_LABEL: Readonly<Record<CertificateEventKind, string>> = {
  viewed: 'Viewed the document',
  consent: 'Accepted the consent text',
  signed: 'Signed',
  completed: 'Completed',
  declined: 'Declined',
};

/** `2026-11-06 10:00:00 UTC`, from a server time in Unix milliseconds. */
function utc(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError('a certificate time is not finite');
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** The identifiers of the appended blocks: 16 characters of the node alphabet, from a counter. */
function idSource(): () => string {
  let n = 0;
  return () => `cert${String(++n).padStart(12, '0')}`;
}

/** The blocks of the certificate, in order. The first starts a new page. */
export function certificateBlocks(facts: CertificateFacts): J[] {
  const next = idSource();
  const blocks: J[] = [];
  const add = (text: string, opts: { bold?: boolean; pageBreak?: boolean } = {}): void => {
    blocks.push({
      type: 'paragraph',
      attrs: {
        id: next(),
        ...(opts.pageBreak ? { pageBreakBefore: true } : {}),
        ...(opts.bold ? { keepNext: true } : {}),
      },
      content: [{ type: 'text', text, ...(opts.bold ? { marks: [{ type: 'bold' }] } : {}) }],
    });
  };
  add('Certificate of completion', { bold: true, pageBreak: true });
  for (const sentence of facts.statement) add(sentence);
  add(`Document: ${facts.documentId}`);
  add(`Workflow: ${facts.workflowId}`);
  add(`Sent at sequence number ${facts.sentSeq}`);
  add(`Completed at sequence number ${facts.completedSeq}`);
  add(`Chain head at completion (SHA-256): ${facts.chainHeadHash}`);
  for (const p of facts.participants) {
    add(`${p.label} (${p.id})`, { bold: true });
    for (const e of p.events) {
      const network =
        facts.networkIdentityIncluded && (e.ipAddress !== undefined || e.userAgent !== undefined)
          ? [
              ...(e.ipAddress !== undefined ? [`address ${e.ipAddress}`] : []),
              ...(e.userAgent !== undefined ? [`user agent ${e.userAgent}`] : []),
            ].join('; ')
          : null;
      add(
        `${EVENT_LABEL[e.kind]}: ${utc(e.serverTimeMs)}${network === null ? '' : `; ${network}`}`,
      );
    }
  }
  return blocks;
}

/** The document with the certificate blocks appended to the end of its body. */
export function appendCertificate(doc: J, facts: CertificateFacts): J {
  const content = (doc['content'] as J[] | undefined) ?? [];
  const at = content.findIndex((c) => c['type'] === 'body');
  if (at < 0) return doc;
  const body = content[at]!;
  const grown: J = {
    ...body,
    content: [...((body['content'] as J[] | undefined) ?? []), ...certificateBlocks(facts)],
  };
  return { ...doc, content: content.map((c, i) => (i === at ? grown : c)) };
}

const KINDS: ReadonlySet<string> = new Set([
  'viewed',
  'consent',
  'signed',
  'completed',
  'declined',
]);
const HEX64 = /^[0-9a-f]{64}$/;

const isText = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length <= max;
const isSeq = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * The certificate facts of a job: null when the job carries none, `invalid` when it
 * carries something that is not the shape the control plane writes. A worker refuses `invalid`
 * rather than print it.
 */
export function readCertificateFacts(value: unknown): CertificateFacts | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const v = value as Record<string, unknown>;
  const people = v['participants'];
  const statement = v['statement'];
  if (
    !isText(v['documentId']) ||
    !isText(v['workflowId']) ||
    !isSeq(v['sentSeq']) ||
    !isSeq(v['completedSeq']) ||
    typeof v['chainHeadHash'] !== 'string' ||
    !HEX64.test(v['chainHeadHash']) ||
    typeof v['networkIdentityIncluded'] !== 'boolean' ||
    !Array.isArray(people) ||
    people.length > 256 ||
    !Array.isArray(statement) ||
    statement.length > 32 ||
    !statement.every((s) => isText(s, 4096))
  )
    return 'invalid';
  for (const p of people as unknown[]) {
    if (p === null || typeof p !== 'object') return 'invalid';
    const q = p as Record<string, unknown>;
    if (!isText(q['id']) || !isText(q['label']) || !Array.isArray(q['events'])) return 'invalid';
    if (q['events'].length > 256) return 'invalid';
    for (const e of q['events'] as unknown[]) {
      if (e === null || typeof e !== 'object') return 'invalid';
      const r = e as Record<string, unknown>;
      if (
        typeof r['kind'] !== 'string' ||
        !KINDS.has(r['kind']) ||
        typeof r['serverTimeMs'] !== 'number' ||
        !Number.isFinite(r['serverTimeMs']) ||
        (r['ipAddress'] !== undefined && !isText(r['ipAddress'], 128)) ||
        (r['userAgent'] !== undefined && !isText(r['userAgent'], 1024))
      )
        return 'invalid';
    }
  }
  return value as CertificateFacts;
}
