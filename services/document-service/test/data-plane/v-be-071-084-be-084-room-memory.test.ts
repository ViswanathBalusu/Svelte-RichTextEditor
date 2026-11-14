// BE-084 measurement (lane V-BE-071-084): the resident memory of one open room, for four document
// sizes, and how much of it a closed room returns. The room is opened and closed by the data plane's
// room host (`services/document-service/src/data-plane/room-host.ts`): `RoomHost.acquire` loads it
// from storage (document record, checkpoint at 0, empty log, permissions) the way the first channel
// does, and `HostedRoom.closeIdle` closes it the way the idle close does (checkpoint if dirty, stop,
// release ownership, drop it from the host). The plane runs in process over the in-memory stores.
//
// Heap figures are `process.memoryUsage().heapUsed` after two forced garbage collections (V8
// `--expose-gc`, set in this file), taken in the Node.js test worker on this machine. They are not
// the reference machine's figures and are not a budget: they say what one room costs here, and where
// the number came from. The record of each size is printed to the test log, with the host's own
// estimate (`HostedRoom.estimatedBytes`, the figure the memory budget of BE-021 uses) beside it.
//
// Assumptions, stated because the spec gives none (06 §10): a page is about 3,000 characters of text
// in paragraphs of 300 characters; "near the limit" is about 15.5 MiB of JSON (the service's limit is
// on its canonical encoding, which this test does not compute). Stored commits, position maps for a
// long log and channels are not in these figures: the room is measured with an empty log and no
// channel. The stored checkpoint is in the heap before the room opens, so it is not counted.
import v8 from 'node:v8';
import vm from 'node:vm';
import type { JsonEnvelope } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_JSON, REQUIRES } from '../../../../packages/authority/test/fixtures.ts';
import { startPlane, type Plane } from './support.ts';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const MIB = 1024 * 1024;
const PARAGRAPH_CHARS = 300;
const PAGE_CHARS = 3000;
const PARAGRAPH_TEXT =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ';

function heapUsed(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

/** A document of `paragraphs` paragraphs of PARAGRAPH_CHARS characters, as CDM JSON. */
function docJson(paragraphs: number): JsonEnvelope['doc'] {
  const content = Array.from({ length: paragraphs }, (_, i) => ({
    type: 'paragraph',
    attrs: { id: `p${i.toString(36).padStart(16, '0')}` },
    content: [{ type: 'text', text: `${i} ${PARAGRAPH_TEXT}`.repeat(4).slice(0, PARAGRAPH_CHARS) }],
  }));
  return {
    type: 'doc',
    content: [BASE_JSON.content[0], { type: 'body', attrs: { pageSetup: 'ps1' }, content }],
  } as JsonEnvelope['doc'];
}

interface Record_ {
  label: string;
  paragraphs: number;
  pages: number;
  jsonMiB: number;
  /** Heap after the room host opened the room, less the heap before. */
  residentMiB: number;
  /** Heap after the room host opened the room, less the heap after it closed it. */
  returnedMiB: number;
  /** The host's own estimate of the room (`HostedRoom.estimatedBytes`). */
  estimatedMiB: number;
}

let p: Plane;
beforeAll(async () => {
  // In-memory stores only (no shared container); the tenant is a fresh UUID, as the stores require.
  p = await startPlane();
});
afterAll(async () => {
  await p.close();
});

/** Stores a document of `paragraphs` paragraphs; returns its id once the stored copy is in place. */
async function storeDocument(paragraphs: number): Promise<string> {
  const doc = await p.createDocument();
  await p.checkpoints.put(p.ref(doc), 0, { cdm: 1, requires: REQUIRES, doc: docJson(paragraphs) });
  return doc;
}

/** Opens the room through the host and returns the figures; the room is held only by the host. */
async function openThroughHost(doc: string): Promise<{ estimated: number }> {
  const room = await p.plane.host.acquire(p.ref(doc));
  expect(p.plane.host.get(p.ref(doc))).toBe(room);
  return { estimated: room.estimatedBytes };
}

/** Closes the room through the host's idle close; resolves when the host no longer holds it. */
async function closeThroughHost(doc: string): Promise<void> {
  const room = p.plane.host.get(p.ref(doc));
  expect(room).toBeDefined();
  expect(await room!.closeIdle()).toBe(true);
}

async function measure(label: string, paragraphs: number): Promise<Record_> {
  const jsonMiB = JSON.stringify(docJson(paragraphs)).length / MIB;
  const doc = await storeDocument(paragraphs);
  const before = heapUsed();
  const { estimated } = await openThroughHost(doc);
  const open = heapUsed();
  await closeThroughHost(doc);
  expect(p.plane.host.get(p.ref(doc))).toBeUndefined();
  expect(p.plane.host.rooms).toHaveLength(0);
  const closed = heapUsed();
  return {
    label,
    paragraphs,
    pages: Math.round((paragraphs * PARAGRAPH_CHARS) / PAGE_CHARS),
    jsonMiB: Number(jsonMiB.toFixed(2)),
    residentMiB: Number(((open - before) / MIB).toFixed(2)),
    returnedMiB: Number(((open - closed) / MIB).toFixed(2)),
    estimatedMiB: Number((estimated / MIB).toFixed(2)),
  };
}

describe('BE-084 room memory, opened and closed by the room host (V-BE-071-084)', () => {
  it('measures the resident memory of an open room at four sizes and what closing it returns', async () => {
    // Size of one paragraph in JSON, from a small document, so that the near-limit size is chosen.
    const perParagraph = JSON.stringify(docJson(1000)).length / 1000;
    const nearLimit = Math.floor((15.5 * MIB) / perParagraph);
    const records: Record_[] = [];
    records.push(await measure('short', 10));
    records.push(await measure('about 20 pages', 20 * (PAGE_CHARS / PARAGRAPH_CHARS)));
    records.push(await measure('about 100 pages', 100 * (PAGE_CHARS / PARAGRAPH_CHARS)));
    records.push(await measure('near 16 MiB', nearLimit));
    for (const r of records) console.log(`BE-084 ${JSON.stringify(r)}`);
    for (const r of records) {
      expect(r.residentMiB).toBeGreaterThan(0);
      expect(r.jsonMiB).toBeLessThan(16);
    }
    expect(records[3]!.jsonMiB).toBeGreaterThan(15);
    // Where the room is large enough for the heap reading to rise above its noise (1 MiB and over),
    // a closed room returns what it held: at least 90 per cent of its resident figure.
    for (const r of records.filter((x) => x.residentMiB >= 1)) {
      expect(r.returnedMiB).toBeGreaterThan(0);
      expect(r.returnedMiB / r.residentMiB).toBeGreaterThanOrEqual(0.9);
    }
    expect(p.errors).toEqual([]);
  }, 600_000);
});
