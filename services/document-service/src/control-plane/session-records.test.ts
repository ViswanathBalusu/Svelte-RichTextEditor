// HIS-003 criterion 3 (08 §2, last paragraph; owner decision 24): what a session record may hold.
// The `User-Agent` header is reduced to a family of a closed list and a major version, the client
// version is kept only when it is shaped like a version, and a record has no other member.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SessionOpened } from '../seams.ts';
import {
  CLIENT_VERSION_MAX,
  MemorySessionRecordStore,
  SESSION_RECORD_MEMBERS,
  SessionRecords,
  USER_AGENT_FAMILIES,
  USER_AGENT_MAJOR_MAX,
  USER_AGENT_MAX,
  reduceClientVersion,
  reduceUserAgent,
  sessionRecordOf,
} from './session-records.ts';

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X)';
const BLINK = 'AppleWebKit/537.36 (KHTML, like Gecko)';
const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';

/** Real header shapes of the supported browsers (02 §12) and of the common others. */
const HEADERS: ReadonlyArray<readonly [string, string, number | null]> = [
  [`${WIN} ${BLINK} Chrome/137.0.0.0 Safari/537.36`, 'chrome', 137],
  [`${WIN} ${BLINK} HeadlessChrome/137.0.7151.0 Safari/537.36`, 'chrome', 137],
  [`${IPHONE} ${WEBKIT} CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1`, 'chrome', 128],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chromium/140.0.0.0', 'chrome', 140],
  [`${WIN} ${BLINK} Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0`, 'edge', 137],
  [
    `Mozilla/5.0 (Linux; Android 14) ${BLINK} Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.0.0`,
    'edge',
    128,
  ],
  [
    `${IPHONE} ${WEBKIT} Version/17.0 EdgiOS/128.0.2739.60 Mobile/15E148 Safari/605.1.15`,
    'edge',
    128,
  ],
  [`${WIN} ${BLINK} Chrome/70.0.3538.102 Safari/537.36 Edge/18.19041`, 'edge', 18],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0', 'firefox', 142],
  [`${IPHONE} ${WEBKIT} FxiOS/130.0 Mobile/15E148 Safari/605.1.15`, 'firefox', 130],
  [`${MAC} ${WEBKIT} Version/17.6 Safari/605.1.15`, 'safari', 17],
  [`${IPHONE} ${WEBKIT} Version/18.1 Mobile/15E148 Safari/604.1`, 'safari', 18],
  // WebKit that names Safari without a `Version/` token: the family is known, the version is not.
  [`${MAC} ${WEBKIT} Safari/605.1.15`, 'safari', null],
  [`${WIN} ${BLINK} Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0`, 'opera', 113],
  [
    `Mozilla/5.0 (Linux; Android 14; SM-S918B) ${BLINK} SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36`,
    'samsung',
    27,
  ],
];

describe('the user agent family and major version (HIS-003; owner decision 24)', () => {
  it.each(HEADERS)('reduces %s', (header, family, major) => {
    expect(reduceUserAgent(header)).toEqual({ family, major });
  });

  it('calls an absent header, an empty one and an unknown agent `other`, with no version', () => {
    for (const header of [
      null,
      undefined,
      '',
      'node',
      'undici',
      'curl/8.5.0',
      'docedit-tck/1.0',
      'Opera/9.80 (Windows NT 6.1) Presto/2.12.388 Version/12.16',
      // An in-app web view on iOS names no browser.
      `${IPHONE} ${WEBKIT} Mobile/15E148`,
    ])
      expect(reduceUserAgent(header), String(header)).toEqual({ family: 'other', major: null });
  });

  it('reads a product token only at the start or after a space, a semicolon or a parenthesis', () => {
    expect(reduceUserAgent('Chrome/5')).toEqual({ family: 'chrome', major: 5 });
    expect(reduceUserAgent('(Chrome/5)')).toEqual({ family: 'chrome', major: 5 });
    expect(reduceUserAgent('x;Firefox/7.1')).toEqual({ family: 'firefox', major: 7 });
    expect(reduceUserAgent('NotChrome/5')).toEqual({ family: 'other', major: null });
    expect(reduceUserAgent('MySafari/605')).toEqual({ family: 'other', major: null });
    // Lower case is not the token.
    expect(reduceUserAgent('chrome/5 firefox/6')).toEqual({ family: 'other', major: null });
  });

  it('keeps the family and drops a major version that is not a number of at most four digits', () => {
    expect(reduceUserAgent('Chrome/9999.1')).toEqual({ family: 'chrome', major: 9999 });
    expect(reduceUserAgent('Chrome/10000')).toEqual({ family: 'chrome', major: null });
    expect(reduceUserAgent(`Chrome/${'9'.repeat(400)}`)).toEqual({ family: 'chrome', major: null });
    expect(reduceUserAgent('Chrome/0')).toEqual({ family: 'chrome', major: 0 });
    // No digits after the slash: the token is not a product with a version.
    expect(reduceUserAgent('Chrome/beta')).toEqual({ family: 'other', major: null });
  });

  it('looks at the first 512 characters only', () => {
    const padding = 'x'.repeat(USER_AGENT_MAX);
    expect(reduceUserAgent(`${padding} Chrome/137.0`)).toEqual({ family: 'other', major: null });
    expect(reduceUserAgent(`Chrome/137.0 ${padding}`)).toEqual({ family: 'chrome', major: 137 });
  });

  it('never returns text of the header: a family of the closed list and a number, whatever is sent', () => {
    const tokens = fc.constantFrom(
      'Chrome/',
      'Edg/',
      'Firefox/',
      'Safari/',
      'Version/',
      'OPR/',
      'SamsungBrowser/',
      ' ',
      ';',
      '(',
      '137',
      'alice@example.test',
      'Alice Example',
    );
    const header = fc.oneof(
      fc.string({ maxLength: 700 }),
      fc
        .array(fc.oneof(tokens, fc.string({ maxLength: 12 })), { maxLength: 40 })
        .map((p) => p.join('')),
    );
    fc.assert(
      fc.property(header, (text) => {
        const r = reduceUserAgent(text);
        expect(Object.keys(r).sort()).toEqual(['family', 'major']);
        expect(USER_AGENT_FAMILIES).toContain(r.family);
        if (r.major !== null) {
          expect(Number.isInteger(r.major)).toBe(true);
          expect(r.major).toBeGreaterThanOrEqual(0);
          expect(r.major).toBeLessThanOrEqual(USER_AGENT_MAJOR_MAX);
        }
        if (r.family === 'other') expect(r.major).toBeNull();
      }),
      { numRuns: 500 },
    );
  });
});

describe('the client version (HIS-003 criterion 3)', () => {
  it('keeps a value shaped like a version as it was sent', () => {
    for (const v of [
      '0',
      '1',
      '0.0.0',
      '1.4.2',
      '1.2.3.4',
      '1.5.0-beta.2',
      '2.0.0+build.7',
      '1.0.0-rc.1+sha.0a1b2c3',
      '2026.11.20',
    ])
      expect(reduceClientVersion(v), v).toBe(v);
  });

  it('stores anything else as unknown: free text, an address, a prefix, a wrong type', () => {
    for (const v of [
      '',
      'v1.2.3',
      '1.2.3.4.5',
      '1..2',
      '1.0.0-',
      '1.0.0+',
      ' 1.0.0',
      '1.0.0 ',
      '1.0.0\n',
      'Alice Example',
      'alice@example.test',
      "1.0 (Alice's laptop)",
      '1.0.0-alice@example.test',
      '1234567.0.0',
      undefined,
      null,
      5,
      {},
      ['1.0.0'],
    ])
      expect(reduceClientVersion(v), JSON.stringify(v)).toBeNull();
  });

  it('keeps at most 64 characters', () => {
    const long = `123456.123456.123456.123456-${'a'.repeat(32)}+${'b'.repeat(32)}`;
    expect(long.length).toBeGreaterThan(CLIENT_VERSION_MAX);
    expect(reduceClientVersion(long)).toBeNull();
    const fits = `1.0.0-${'a'.repeat(32)}+${'b'.repeat(25)}`;
    expect(fits.length).toBe(CLIENT_VERSION_MAX);
    expect(reduceClientVersion(fits)).toBe(fits);
  });

  it('never keeps a character outside digits, letters, dots, hyphens and one plus sign', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (text) => {
        const v = reduceClientVersion(text);
        if (v === null) return;
        expect(v).toBe(text);
        expect(v.length).toBeLessThanOrEqual(CLIENT_VERSION_MAX);
        expect(v).toMatch(/^[0-9][0-9A-Za-z.+-]*$/);
        expect(v.split('+').length).toBeLessThanOrEqual(2);
      }),
      { numRuns: 500 },
    );
  });
});

const TENANT = '0190f2a4-0000-7000-8000-00000000000a';
const OTHER_TENANT = '0190f2a4-0000-7000-8000-00000000000b';
const DOC = '0190f2a4-0000-7000-8000-0000000000d1';
const OTHER_DOC = '0190f2a4-0000-7000-8000-0000000000d2';
const RAW = `${WIN} ${BLINK} Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0`;

function opened(over: Partial<SessionOpened> = {}): SessionOpened {
  return {
    tenant: TENANT,
    doc: DOC,
    session: 'session-1',
    user: 'surrogate-1',
    userAgent: RAW,
    clientVersion: '1.4.2',
    ...over,
  };
}

describe('a session record (HIS-003 criterion 3)', () => {
  it('holds the session, the surrogate, the family with its major version and the client version, and no other member', () => {
    const record = sessionRecordOf(opened());
    expect(record).toEqual({
      tenant: TENANT,
      document: DOC,
      session: 'session-1',
      user: 'surrogate-1',
      userAgentFamily: 'edge',
      userAgentMajor: 137,
      clientVersion: '1.4.2',
    });
    expect(Object.keys(record).sort()).toEqual([...SESSION_RECORD_MEMBERS].sort());
    // Nothing of the header's own text is in the record: no platform, no build, no engine.
    const text = JSON.stringify(record);
    for (const part of ['Mozilla', 'Windows', 'Win64', 'AppleWebKit', '537.36', '137.0.0.0'])
      expect(text, part).not.toContain(part);
  });

  it('stores an unknown agent and a version that is free text as unknown', () => {
    expect(
      sessionRecordOf(opened({ userAgent: null, clientVersion: 'build of Alice Example' })),
    ).toMatchObject({ userAgentFamily: 'other', userAgentMajor: null, clientVersion: null });
  });

  it('is stored once per session and document; the first record stays', async () => {
    const store = new MemorySessionRecordStore();
    const records = new SessionRecords(store);
    await records.opened(opened());
    // The same session opens the document again: nothing changes, whatever it sends now.
    await records.opened(
      opened({ userAgent: 'Mozilla/5.0 Gecko/20100101 Firefox/142.0', clientVersion: '9.9.9' }),
    );
    expect(await records.of(TENANT, DOC)).toEqual([sessionRecordOf(opened())]);
    expect(await records.get(TENANT, DOC, 'session-1')).toEqual(sessionRecordOf(opened()));
    expect(await records.get(TENANT, DOC, 'session-2')).toBeNull();
  });

  it('keeps one record per document of a session, and each tenant and document apart', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore());
    await records.opened(opened({ session: 'session-b' }));
    await records.opened(opened({ session: 'session-a', user: 'surrogate-2' }));
    await records.opened(opened({ session: 'session-a', doc: OTHER_DOC }));
    await records.opened(opened({ tenant: OTHER_TENANT, session: 'session-z' }));
    expect((await records.of(TENANT, DOC)).map((r) => [r.session, r.user])).toEqual([
      ['session-a', 'surrogate-2'],
      ['session-b', 'surrogate-1'],
    ]);
    expect((await records.of(TENANT, OTHER_DOC)).map((r) => r.session)).toEqual(['session-a']);
    expect((await records.of(OTHER_TENANT, DOC)).map((r) => r.session)).toEqual(['session-z']);
    expect(await records.of(OTHER_TENANT, OTHER_DOC)).toEqual([]);
  });

  it('gives copies: a caller cannot change what is stored', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore());
    await records.opened(opened());
    const first = (await records.of(TENANT, DOC))[0]!;
    (first as { user: string }).user = 'changed';
    expect((await records.of(TENANT, DOC))[0]!.user).toBe('surrogate-1');
  });

  it('rejects when the store fails, so the data plane does not open the channel', async () => {
    const failing = new SessionRecords({
      record: () => Promise.reject(new Error('the database is unreachable')),
      get: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
    });
    await expect(failing.opened(opened())).rejects.toThrow('the database is unreachable');
  });
});
