// FRW-036 criterion 3 (lane w4), the service's half: no code of the workflow sends an e-mail or a text
// message or opens a connection of its own, and the only code in the service that makes an HTTP
// request is the webhook egress proxy (`webhook-egress.ts`). The package half, that no package holds
// a mail or SMS client, is packages/authority/test/frw-036.no-mail-path.test.ts. The delivery itself
// through the egress proxy is tested in frw-036.workflow-webhooks.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((n) => join(dir, String(n)))
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && statSync(f).isFile());
}

const ALL = sources(SRC);
/** The workflow's code: its own folder and the route modules named for it. */
const WORKFLOW = ALL.filter((f) => {
  const rel = relative(SRC, f).replaceAll('\\', '/');
  return rel.startsWith('workflow/') || /(^|\/)workflow-[a-z-]*\.ts$/.test(rel);
});

/** Mail, SMS and voice clients and their cloud APIs (as in the authority's scan). */
const MESSAGING =
  /nodemailer|smtp|sendgrid|mailgun|postmark|mailjet|sparkpost|sendmail|twilio|vonage|messagebird|plivo|client-ses|client-sns/i;
/** Modules that open a connection, and the global calls that do. */
const NETWORK_IMPORT =
  /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process|undici)['"]/;
const NETWORK_CALL = /\bfetch\s*\(|new\s+(?:WebSocket|XMLHttpRequest)\b|\bnavigator\.sendBeacon\b/;

describe('the workflow opens no connection of its own and sends no message (FRW-036 criterion 3)', () => {
  it('has workflow modules to scan, among them the routes and the transition record', () => {
    const names = WORKFLOW.map((f) => relative(SRC, f).replaceAll('\\', '/'));
    expect(names).toEqual(
      expect.arrayContaining([
        'control-plane/workflow-routes.ts',
        'workflow/transitions.ts',
        'workflow/progress.ts',
        'workflow/correction.ts',
      ]),
    );
  });

  it('imports no network module and makes no fetch, socket or beacon call', () => {
    for (const file of WORKFLOW) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(SRC, file)).not.toMatch(NETWORK_IMPORT);
      expect(text, relative(SRC, file)).not.toMatch(NETWORK_CALL);
    }
  });

  it('names no mail, SMS or voice client, in its code or in the service configuration', () => {
    for (const file of [...WORKFLOW, join(SRC, 'config.ts')])
      expect(readFileSync(file, 'utf8'), relative(SRC, file)).not.toMatch(MESSAGING);
  });
});

describe('the only HTTP request the service makes is the webhook egress (FRW-036 criterion 3)', () => {
  it('imports `request` from node:http or node:https in webhook-egress.ts and nowhere else', () => {
    const importers = ALL.filter((f) =>
      /import\s*\{[^}]*\brequest\b[^}]*\}\s*from\s*['"]node:https?['"]/.test(
        readFileSync(f, 'utf8'),
      ),
    ).map((f) => relative(SRC, f).replaceAll('\\', '/'));
    expect(importers).toEqual(['control-plane/webhook-egress.ts']);
  });

  it('keeps the workflow events on the event sink, which the dispatcher drains through that proxy', () => {
    const routes = readFileSync(join(SRC, 'control-plane/workflow-routes.ts'), 'utf8');
    expect(routes).toContain('k.emit(');
    expect(routes).not.toMatch(/webhook-egress|connector|resolver/i);
  });
});
