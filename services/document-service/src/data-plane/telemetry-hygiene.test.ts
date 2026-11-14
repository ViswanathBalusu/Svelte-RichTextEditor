/**
 * Logs and traces hold no document content and no token (PRO-044 criterion 4; 06 §11). The test
 * runs a traced session that types a secret text, and a second connection that presents a bogus
 * token, then searches every recorded span and every error the data plane reported for the typed
 * text, the valid token and the bogus token. The searches are not vacuous: the test first checks
 * that the spans of the commit were recorded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { DepClient, insertText } from '../../test/data-plane/client.ts';
import { startPlane, until, type Plane } from '../../test/data-plane/support.ts';
import type { Span } from '../seams.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const traceparent = `00-${TRACE}-00f067aa0ba902b7-01`;
const SECRET_TEXT = 'a typed passage that must stay out of logs 7f3c';
const BOGUS_TOKEN = 'bogus-token-do-not-log-91ab';

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('logs and traces hold no content and no tokens (PRO-044 criterion 4)', () => {
  it('keeps the typed text and both tokens out of every span and every logged error', async () => {
    const spans: Span[] = [];
    const p = await startPlane({ settings: { onSpan: (s: Span) => void spans.push(s) } });
    planes.push(p);
    const doc = await p.createDocument();
    const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });

    const c = await DepClient.connect(p.url);
    await c.hello(token, { traceparent });
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    expect((await c.submit(1, { base: 0, steps: [insertText(intro(), SECRET_TEXT)] })).t).toBe(
      'sync.ack',
    );

    // A connection that presents a token the verifier refuses: the refusal is answered on the wire.
    const bad = await DepClient.connect(p.url);
    const refused = await bad.hello(BOGUS_TOKEN);
    expect(refused.t).toBe('error');

    c.terminate();
    bad.terminate();
    await until(() => spans.some((s) => s.name === 'dep.session' && s.traceId === TRACE));
    // Non-vacuous: the commit was traced, so its attributes were searched.
    expect(spans.some((s) => s.name === 'dep.commit')).toBe(true);

    const logged = JSON.stringify({
      spans,
      errors: p.errors.map((e) => ({
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? '') : '',
      })),
    });
    expect(logged).not.toContain(SECRET_TEXT);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(BOGUS_TOKEN);
  });
});
