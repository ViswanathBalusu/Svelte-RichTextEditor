/**
 * A reference client for the property tests (04 §7 to §9; SYN-017 to SYN-020 in miniature). It keeps
 * its confirmed document and rebuilds from it, never by applying stored inverses. Edits are random:
 * well-behaved clients respect their access (a region guard), malicious ones send crafted commits.
 */
import type { Node } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  Step,
  Transform,
} from 'prosemirror-transform';
import type { Access } from '../../src/permissions/access.ts';
import type { Caps, Connection } from '../../src/permissions/model.ts';
import { applySteps, inverseMapsOf, mapsOf, rebaseOver } from '../../src/rebase.ts';
import type {
  CloseReason,
  CommitInput,
  Resume,
  StoredCommit,
  ToClient,
} from '../../src/room/types.ts';
import { stepsEqual, stepsToJson } from '../../src/steps.ts';
import { addSuggestion, entriesAt, removeSuggestion } from '../block-suggest.ts';
import { schema as defaultSchema } from '../fixtures.ts';
import type { Schema } from 'prosemirror-model';

export type ToServer =
  | { t: 'open'; channel: string; conn: Connection; resume?: Resume }
  | { t: 'submit'; channel: string; commit: CommitInput };

interface Inflight {
  id: string;
  base: number;
  /** As sent; resent unchanged on `retry`. */
  sent: Step[];
  json: unknown[];
  /** The same work, rebased locally over commits received since; empty for raw commits. */
  local: Step[];
  needsResend: boolean;
}

let idCounter = 0;
/** Deterministic UUID version 7 identifiers, so that failing runs replay exactly. */
export function simId(): string {
  idCounter++;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `0192f0c4-7b1e-7000-8000-${hex}`;
}
let nodeCounter = 0;
export function simNodeId(prefix = 'n'): string {
  nodeCounter++;
  return `${prefix}${String(nodeCounter).padStart(15, '0')}`.slice(0, 16);
}
export function resetIds(): void {
  idCounter = 0;
  nodeCounter = 0;
}

interface Spot {
  pos: number;
  scope: string;
  start: number;
  end: number;
}

function textSpots(doc: Node): Spot[] {
  const out: Spot[] = [];
  const body = doc.child(doc.childCount - 1);
  const bodyStart = doc.content.size - body.nodeSize + 1;
  body.forEach((child, offset) => {
    const at = bodyStart + offset;
    const scope = child.type.name === 'region' ? `region:${String(child.attrs['id'])}` : 'body';
    const visit = (n: Node, pos: number) => {
      if (n.type.name === 'paragraph') {
        const start = pos + 1;
        const end = start + n.content.size;
        // Positions between inline children only (never inside an inline atom with content).
        let p = start;
        out.push({ pos: p, scope, start, end });
        n.forEach((c) => {
          p += c.nodeSize;
          if (c.isText)
            for (let i = p - c.nodeSize + 1; i <= p; i++) out.push({ pos: i, scope, start, end });
          else out.push({ pos: p, scope, start, end });
        });
        return;
      }
      n.forEach((c, o) => visit(c, pos + 1 + o));
    };
    visit(child, at);
  });
  return out;
}

/** The tabs of the body that carry a node mark, with the scope each sits in. */
function markedTabs(doc: Node): Array<{ node: Node; pos: number; scope: string }> {
  const out: Array<{ node: Node; pos: number; scope: string }> = [];
  const body = doc.child(doc.childCount - 1);
  const bodyStart = doc.content.size - body.nodeSize + 1;
  body.forEach((child, offset) => {
    const at = bodyStart + offset;
    const scope = child.type.name === 'region' ? `region:${String(child.attrs['id'])}` : 'body';
    child.descendants((n, pos) => {
      if (n.type.name === 'tab' && n.marks.length) out.push({ node: n, pos: at + 1 + pos, scope });
      return true;
    });
  });
  return out;
}

function nodesOfType(doc: Node, type: string): Array<{ node: Node; pos: number }> {
  const out: Array<{ node: Node; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === type) out.push({ node, pos });
    return true;
  });
  return out;
}

function trackEveryone(doc: Node): boolean {
  return doc.child(0).child(0).attrs['trackChanges'] === 'everyone';
}

export class SimClient {
  confirmed: Node | null = null;
  confirmedSeq = 0;
  incarnation = '';
  /** View token of the projection the confirmed document is for (S12); undefined without a gateway. */
  view: string | undefined = undefined;
  visible: Node | null = null;
  inflight: Inflight | null = null;
  queue: Step[] = [];
  access: Access | null = null;
  channel: string | null = null;
  open = false;
  catchingUp = false;
  resendAfterCaughtUp = false;
  waitForHead: number | null = null;
  wantsReconnect = true;
  outbox: ToServer[] = [];
  recovered = 0;
  /** Snapshot resets handled (04 §8, `sync.reset`). */
  resets = 0;
  /** Whether the channel was opened with `catchUp: "page"` and the missing commits are still due. */
  paging = false;
  /** The head of that `ch.opened`: the client pages up to it, live commits follow it. */
  private pageTo = 0;
  /** Why the server last closed the channel, when it said. */
  closedFor: CloseReason | undefined = undefined;
  readonly acks: Array<{ id: string; seq: number }> = [];
  /** Every commit the client applied to its confirmed document, in order (G1); null for a reset. */
  readonly applied: Array<{ seq: number; id: string | null }> = [];
  /** Commit ids this client created (for the attribution check, G6). */
  readonly created = new Set<string>();
  /** Commit ids of other users seen in the stream (malicious replay). */
  readonly seenIds: string[] = [];
  readonly suggestionId: string;
  readonly name: string;
  /** The claims of the client's token; a refresh can change them (05 §3.1). */
  conn: Connection;
  readonly malicious: boolean;
  /** The schema the client edits with: the CDM schema, or the projection schema for readers (S12). */
  readonly schema: Schema;
  private channels = 0;

  constructor(name: string, conn: Connection, malicious: boolean, schema: Schema = defaultSchema) {
    this.schema = schema;
    this.name = name;
    this.conn = conn;
    this.malicious = malicious;
    this.suggestionId = `s${name.padEnd(15, 'x')}`.slice(0, 16);
  }

  // -- connection ---------------------------------------------------------------------------------

  connect(): string {
    this.channels++;
    const channel = `${this.name}#${this.channels}`;
    this.channel = channel;
    this.open = false;
    this.catchingUp = false;
    this.wantsReconnect = false;
    const resume: Resume | undefined = this.confirmed
      ? {
          seq: this.confirmedSeq,
          incarnation: this.incarnation,
          inflight: this.inflight?.id ?? null,
          ...(this.view ? { view: this.view } : {}),
        }
      : undefined;
    this.outbox = [{ t: 'open', channel, conn: this.conn, ...(resume ? { resume } : {}) }];
    return channel;
  }

  disconnected(): void {
    this.channel = null;
    this.open = false;
    this.catchingUp = false;
    this.outbox = [];
    this.wantsReconnect = true;
    if (this.inflight) this.inflight.needsResend = false;
  }

  get idle(): boolean {
    return (
      this.open &&
      !this.catchingUp &&
      !this.inflight &&
      this.queue.length === 0 &&
      this.outbox.length === 0
    );
  }

  // -- receiving ----------------------------------------------------------------------------------

  receive(msg: ToClient): void {
    switch (msg.t) {
      case 'ch.opened':
        this.open = true;
        this.access = msg.access;
        this.incarnation = msg.incarnation;
        if (msg.catchUp === 'reload') {
          if (!msg.content) throw new Error('reload without content');
          this.recovered += (this.inflight?.local.length ?? 0) + this.queue.length;
          this.inflight = null;
          this.queue = [];
          this.waitForHead = null;
          this.confirmed = this.schema.nodeFromJSON(msg.content.doc);
          this.confirmedSeq = msg.content.seq;
          this.visible = this.confirmed;
          this.catchingUp = false;
          // The view this document is a projection for (read restrictions, ADR 0019).
          this.view = msg.view;
        } else {
          // `stream`: the missing commits follow on the channel. `page`: they are read over REST
          // (`paged()`), and live commits from the head follow (04 §9 step 4).
          this.catchingUp = true;
          this.paging = msg.catchUp === 'page';
          this.pageTo = msg.head;
          this.resendAfterCaughtUp = this.inflight !== null && msg.inflight?.state === 'unknown';
          // Accepted at or behind our head: the stream will not repeat it, so it cannot be ours.
          if (
            this.inflight &&
            msg.inflight?.state === 'accepted' &&
            msg.inflight.seq <= this.confirmedSeq
          )
            this.dropInflight();
        }
        return;
      case 'sync.caughtUp':
        this.catchingUp = false;
        if (this.resendAfterCaughtUp && this.inflight) this.inflight.needsResend = true;
        this.resendAfterCaughtUp = false;
        return;
      case 'sync.commit': {
        const c = msg.commit;
        if (c.seq !== this.confirmedSeq + 1) return this.gap();
        const steps = c.steps.map((s) => Step.fromJSON(this.schema, s));
        this.applied.push({ seq: c.seq, id: c.id });
        if (this.inflight && c.id === this.inflight.id) {
          // Our own commit in the stream is the acknowledgement (04 §8).
          this.acks.push({ id: c.id, seq: c.seq });
          this.confirm(c.seq, steps);
          return;
        }
        if (c.user !== this.conn.sub) this.seenIds.push(c.id);
        const r = applySteps(this.confirmed!, steps);
        if (!r.ok)
          throw new Error(
            `${this.name}: a confirmed commit failed to apply (${r.reason}): divergence`,
          );
        this.confirmedSeq = c.seq;
        this.rebaseLocal(mapsOf(steps), r.value.doc);
        return;
      }
      case 'sync.reset': {
        // A snapshot commit was stored (04 §8): replace the confirmed document and re-apply the
        // local steps; those that fail go to recovered edits. The in-flight commit's base is now
        // older than the snapshot, so its rejection (`stale_base`) is no longer awaited: its work is
        // in the queue and goes out as a new commit (04 §3.2).
        if (msg.seq !== this.confirmedSeq + 1) return this.gap();
        this.applied.push({ seq: msg.seq, id: null });
        const next = this.schema.nodeFromJSON(msg.content.doc);
        // A crafted commit whose base was ahead of the head can name the snapshot's seq as its base
        // and still be accepted after it: its answer is still awaited.
        const awaited =
          this.inflight !== null &&
          this.inflight.local.length === 0 &&
          this.inflight.base >= msg.seq
            ? this.inflight
            : null;
        const local = [...(awaited ? [] : (this.inflight?.local ?? [])), ...this.queue];
        this.inflight = awaited;
        this.waitForHead = null;
        // The steps are tried in order on the new content, by position: nothing maps the old
        // document to the new one. A step made after one that fails was made on a document that
        // held the failed step's change, so it is mapped back over that change first (the drop mode
        // of the rebase, with nothing to rebase over). Without that it would be applied as far from
        // its place as the failed step had moved the text behind it.
        const rr = rebaseOver(local, [], next, 'drop');
        if (!rr.ok) throw new Error('drop-mode rebase cannot fail');
        this.recovered += rr.value.dropped.length;
        this.confirmed = next;
        this.confirmedSeq = msg.seq;
        this.visible = rr.value.doc;
        this.queue = rr.value.steps;
        if (msg.view !== undefined) this.view = msg.view;
        this.resets++;
        return;
      }
      case 'sync.ack': {
        if (!this.inflight || msg.id !== this.inflight.id) return;
        if (msg.seq !== this.confirmedSeq + 1) return this.gap();
        this.applied.push({ seq: msg.seq, id: msg.id });
        this.acks.push({ id: msg.id, seq: msg.seq });
        const steps = msg.rebased
          ? (msg.steps ?? []).map((s) => Step.fromJSON(this.schema, s))
          : this.inflight.sent;
        this.confirm(msg.seq, steps);
        return;
      }
      case 'sync.reject': {
        if (!this.inflight || msg.id !== this.inflight.id) return;
        switch (msg.action) {
          case 'retry':
            this.inflight.needsResend = true;
            return;
          case 'rebase':
            this.queue = [...this.inflight.local, ...this.queue];
            this.inflight = null;
            this.waitForHead = msg.head;
            return;
          case 'drop':
            return this.dropInflight();
          case 'reload':
            this.confirmed = null;
            this.recovered += (this.inflight?.local.length ?? 0) + this.queue.length;
            this.inflight = null;
            this.queue = [];
            this.disconnected();
            return;
        }
        return;
      }
      case 'perm.changed':
        this.access = msg.access;
        return;
      case 'ch.closed':
        this.closedFor = msg.reason;
        this.disconnected();
        return;
    }
  }

  /**
   * The missing commits after a `catchUp: "page"`, as `GET /documents/{id}/commits` returns them
   * (05 §6.2). Live commits from the head follow on the channel; an in-flight commit reported
   * `unknown` is resubmitted once the client has caught up (04 §9 step 5).
   */
  paged(commits: readonly StoredCommit[]): void {
    if (!this.paging) return;
    for (const c of commits) {
      if (c.seq <= this.confirmedSeq || c.seq > this.pageTo) continue;
      this.receive({ t: 'sync.commit', commit: c });
      if (!this.channel) return; // a gap closed the channel
    }
    this.paging = false;
    this.receive({ t: 'sync.caughtUp', head: this.confirmedSeq });
  }

  private gap(): void {
    this.disconnected();
  }

  private confirm(seq: number, ackSteps: Step[]): void {
    const inf = this.inflight!;
    const r = applySteps(this.confirmed!, ackSteps);
    if (!r.ok)
      throw new Error(`${this.name}: acknowledged steps failed to apply (${r.reason}): divergence`);
    const next = r.value.doc;
    this.confirmedSeq = seq;
    this.inflight = null;
    if (stepsEqual(ackSteps, inf.local)) {
      this.confirmed = next; // the visible state is already confirmed plus the queue
      return;
    }
    const over = [...inverseMapsOf(inf.local), ...mapsOf(ackSteps)];
    const rr = rebaseOver(this.queue, over, next, 'drop');
    if (!rr.ok) throw new Error('drop-mode rebase cannot fail');
    this.queue = rr.value.steps;
    this.recovered += rr.value.dropped.length;
    this.visible = rr.value.doc;
    this.confirmed = next;
  }

  private rebaseLocal(over: ReturnType<typeof mapsOf>, next: Node): void {
    const nInf = this.inflight?.local.length ?? 0;
    const local = [...(this.inflight?.local ?? []), ...this.queue];
    const rr = rebaseOver(local, over, next, 'drop');
    if (!rr.ok) throw new Error('drop-mode rebase cannot fail');
    const pos = rr.value.positions;
    const pick = (from: number, to: number) =>
      pos
        .slice(from, to)
        .filter((i) => i >= 0)
        .map((i) => rr.value.steps[i]!);
    if (this.inflight) this.inflight.local = pick(0, nInf);
    this.queue = pick(nInf, local.length);
    this.recovered += rr.value.dropped.length;
    this.visible = rr.value.doc;
    this.confirmed = next;
  }

  private dropInflight(): void {
    const inf = this.inflight!;
    this.inflight = null;
    this.recovered += Math.max(1, inf.local.length);
    const rr = rebaseOver(this.queue, inverseMapsOf(inf.local), this.confirmed!, 'drop');
    if (!rr.ok) throw new Error('drop-mode rebase cannot fail');
    this.queue = rr.value.steps;
    this.recovered += rr.value.dropped.length;
    this.visible = rr.value.doc;
  }

  // -- sending ------------------------------------------------------------------------------------

  trySend(): boolean {
    if (!this.open || this.catchingUp || !this.channel) return false;
    if (this.inflight) {
      if (!this.inflight.needsResend) return false;
      this.inflight.needsResend = false;
      this.outbox.push({
        t: 'submit',
        channel: this.channel,
        commit: { id: this.inflight.id, base: this.inflight.base, steps: this.inflight.json },
      });
      return true;
    }
    if (this.waitForHead !== null && this.confirmedSeq < this.waitForHead) return false;
    this.waitForHead = null;
    if (this.queue.length === 0) return false;
    const id = simId();
    this.created.add(id);
    const json = stepsToJson(this.queue);
    this.inflight = {
      id,
      base: this.confirmedSeq,
      sent: this.queue,
      json,
      local: this.queue,
      needsResend: false,
    };
    this.queue = [];
    this.outbox.push({
      t: 'submit',
      channel: this.channel,
      commit: { id, base: this.confirmedSeq, steps: json },
    });
    return true;
  }

  // -- editing ------------------------------------------------------------------------------------

  private caps(scope: string): Caps | null {
    if (!this.access) return null;
    if (scope === 'body') return this.access.body;
    return this.access.regions.get(scope.slice(7)) ?? this.access.newRegion;
  }

  /** A random edit through a region guard; returns false when nothing applicable was found. */
  edit(kind: number, a: number, b: number, text: string): boolean {
    const doc = this.visible;
    if (!doc) return false;
    const tr = new Transform(doc);
    const everyone = trackEveryone(doc);
    const me = this.conn.sub;
    const spots = textSpots(doc).filter((s) => {
      const c = this.caps(s.scope);
      return this.malicious || (c !== null && (c.has('edit') || c.has('suggest')));
    });
    const spot = spots.length ? spots[a % spots.length]! : null;
    const mode = (scope: string) => {
      const c = this.caps(scope);
      if (!c) return 'none';
      if (c.has('edit') && !everyone) return 'edit';
      if (c.has('suggest')) return 'suggest';
      return this.malicious ? 'edit' : 'none';
    };
    const ins = () => this.schema.marks['ins']!.create({ id: this.suggestionId, user: me });
    const del = () => this.schema.marks['del']!.create({ id: this.suggestionId, user: me });
    try {
      switch (kind % 12) {
        case 0:
        case 1: {
          if (!spot) return false;
          const m = mode(spot.scope);
          if (m === 'none') return false;
          tr.insert(spot.pos, this.schema.text(text || 'x', m === 'suggest' ? [ins()] : []));
          break;
        }
        case 2: {
          if (!spot) return false;
          const to = Math.min(spot.end, spot.pos + 1 + (b % 6));
          if (to <= spot.pos) return false;
          const m = mode(spot.scope);
          if (m === 'edit') tr.delete(spot.pos, to);
          else if (m === 'suggest') tr.addMark(spot.pos, to, del());
          else return false;
          break;
        }
        case 3: {
          if (!spot || mode(spot.scope) !== 'edit') return false;
          const to = Math.min(spot.end, spot.pos + 1 + (b % 8));
          if (to <= spot.pos) return false;
          tr.addMark(spot.pos, to, this.schema.marks[b % 2 ? 'bold' : 'italic']!.create());
          break;
        }
        case 4: {
          if (!spot || mode(spot.scope) !== 'edit') return false;
          tr.split(spot.pos);
          const $at = tr.doc.resolve(tr.mapping.map(spot.pos));
          tr.setNodeAttribute($at.before($at.depth), 'id', simNodeId('p'));
          break;
        }
        case 5: {
          // Restyle a paragraph: as an attribute step, or by rewrapping it (setNodeMarkup gives a
          // replaceAround step).
          if (!spot || mode(spot.scope) !== 'edit') return false;
          const $p = doc.resolve(spot.pos);
          const style = ['Normal', 'Heading1', null][b % 3] ?? null;
          if (b % 2) tr.setNodeAttribute($p.before($p.depth), 'style', style);
          else tr.setNodeMarkup($p.before($p.depth), null, { ...$p.parent.attrs, style });
          break;
        }
        case 6: {
          // Fill a field: fillers through `fill`, editors directly where they may edit.
          const fields = nodesOfType(doc, 'form_field');
          if (!fields.length) return false;
          const f = fields[a % fields.length]!;
          tr.step(new AttrStep(f.pos, 'value', text || 'value'));
          break;
        }
        case 7: {
          // Structure: add a region, delete one, flip a policy, or toggle track changes.
          if (!this.access?.docRole.has('structure') && !this.malicious) return false;
          const body = doc.child(doc.childCount - 1);
          const bodyStart = doc.content.size - body.nodeSize + 1;
          const choice = b % 4;
          if (choice === 0) {
            let at = bodyStart;
            const i = a % (body.childCount + 1);
            for (let k = 0; k < i; k++) at += body.child(k).nodeSize;
            const region = this.schema.nodeFromJSON({
              type: 'region',
              attrs: { id: simNodeId('r') },
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: simNodeId('p') },
                  content: [{ type: 'text', text: text || 'new' }],
                },
              ],
            });
            tr.insert(at, region);
          } else if (choice === 1) {
            const regions = nodesOfType(doc, 'region');
            if (!regions.length) return false;
            const r = regions[a % regions.length]!;
            if (!this.malicious && !this.caps(`region:${String(r.node.attrs['id'])}`)?.has('edit'))
              return false;
            tr.delete(r.pos, r.pos + r.node.nodeSize);
          } else if (choice === 2) {
            if (!this.access?.docRole.has('manage') && !this.malicious) return false;
            const regions = nodesOfType(doc, 'region');
            if (!regions.length) return false;
            const r = regions[a % regions.length]!;
            tr.setNodeAttribute(
              r.pos,
              'policy',
              r.node.attrs['policy'] === 'restricted' ? 'inherit' : 'restricted',
            );
          } else {
            if (!this.access?.docRole.has('manage') && !this.malicious) return false;
            const settingsPos = 1;
            tr.step(new AttrStep(settingsPos, 'trackChanges', everyone ? 'off' : 'everyone'));
          }
          break;
        }
        case 8: {
          // Restyle a definition (07 §5.3 decides whether that is allowed).
          if (!this.access?.docRole.has('structure') && !this.malicious) return false;
          const styles = nodesOfType(doc, 'style_def');
          const s = styles[a % styles.length]!;
          tr.step(new AttrStep(s.pos, 'color', ['#FF0000', '#00AA00', null][b % 3] ?? null));
          break;
        }
        case 9: {
          // Remove a mark (removeMark) from text that carries one: formatting where one may edit,
          // one's own suggested deletion where one only suggests.
          const removable = (s: Spot) => {
            const m = mode(s.scope);
            const node = doc.nodeAt(s.pos);
            if (!node?.isText) return null;
            if (m === 'edit')
              return node.marks.find((x) => x.type.name === 'bold' || x.type.name === 'italic');
            if (m === 'suggest')
              return node.marks.find(
                (x) => x.type.name === 'del' && x.attrs['id'] === this.suggestionId,
              );
            return undefined;
          };
          const marked = spots.filter((s) => removable(s));
          if (!marked.length) return false;
          const s = marked[a % marked.length]!;
          const to = Math.min(s.end, s.pos + 1 + (b % 10));
          tr.removeMark(s.pos, to, removable(s)!);
          break;
        }
        case 10: {
          // A suggested deletion or insertion of a whole paragraph is an entry of its `suggest`
          // attribute (03 §5; owner decision 92); an inline node (a tab) still takes node marks, so
          // half of the time a tab is put in and marked (addNodeMark).
          if (!spot) return false;
          const m = mode(spot.scope);
          if (m === 'none') return false;
          if (b % 2) {
            const tab = this.schema.nodes['tab']!.create(
              null,
              null,
              m === 'suggest' ? [ins()] : [],
            );
            tr.insert(spot.pos, tab);
            tr.addNodeMark(spot.pos, m === 'edit' && b % 4 === 3 ? ins() : del());
            break;
          }
          const $p = doc.resolve(spot.pos);
          if ($p.parent.type.name !== 'paragraph') return false;
          tr.step(
            addSuggestion(tr.doc, $p.before($p.depth), m === 'edit' && b % 4 === 2 ? ins() : del()),
          );
          break;
        }
        case 11: {
          // Take a suggestion off again: a mark off a tab (removeNodeMark) or an entry off a
          // paragraph (`suggest`). Any where one may edit, one's own where one only suggests.
          if (a % 2) {
            const tabs = markedTabs(doc);
            if (!tabs.length) return false;
            const t = tabs[b % tabs.length]!;
            const m = mode(t.scope);
            const mark = t.node.marks.find((x) => m === 'edit' || x.attrs['user'] === me);
            if (m === 'none' || !mark) return false;
            tr.removeNodeMark(t.pos, mark);
            break;
          }
          const marked = textSpots(doc).filter((s) => {
            const $s = doc.resolve(s.pos);
            return (
              $s.parent.type.name === 'paragraph' && entriesAt(doc, $s.before($s.depth)).length > 0
            );
          });
          if (!marked.length) return false;
          const s = marked[a % marked.length]!;
          const m = mode(s.scope);
          const $s = doc.resolve(s.pos);
          const at = $s.before($s.depth);
          const entry = entriesAt(doc, at).find((x) => m === 'edit' || x.attrs.user === me);
          if (m === 'none' || !entry) return false;
          tr.step(removeSuggestion(tr.doc, at, entry.attrs.id));
          break;
        }
      }
    } catch {
      return false;
    }
    if (!tr.steps.length) return false;
    this.queue.push(...tr.steps);
    this.visible = tr.doc;
    return true;
  }

  /** A crafted commit sent without applying it locally (malicious clients only). */
  evil(kind: number, a: number, b: number): boolean {
    if (
      !this.malicious ||
      !this.open ||
      this.catchingUp ||
      !this.channel ||
      this.inflight ||
      !this.visible
    )
      return false;
    const doc = this.visible;
    const size = doc.content.size;
    let json: unknown[];
    let base = this.confirmedSeq;
    let id = simId();
    const regions = nodesOfType(doc, 'region');
    const paragraphs = nodesOfType(doc, 'paragraph');
    try {
      switch (kind % 10) {
        case 0: {
          // Insert into the restricted region, whatever the access says.
          const legal =
            paragraphs.find((p) => p.node.attrs['id'] === 'pLegal000000001B') ??
            paragraphs[a % paragraphs.length]!;
          json = [
            new ReplaceStep(
              legal.pos + 1,
              legal.pos + 1,
              new Slice(Fragment.from(this.schema.text('pwned ')), 0, 0),
            ).toJSON(),
          ];
          break;
        }
        case 1: {
          // Forge a suggestion in someone else's name.
          const p = paragraphs[a % paragraphs.length]!;
          const mark = this.schema.marks['ins']!.create({ id: 'sForgedSuggest01', user: 'carol' });
          json = [
            new ReplaceStep(
              p.pos + 1,
              p.pos + 1,
              new Slice(Fragment.from(this.schema.text('forged', [mark])), 0, 0),
            ).toJSON(),
          ];
          break;
        }
        case 2: {
          // Change a node's identifier (I2) or a region's policy without `manage` (P2).
          const target =
            b % 2 && regions.length
              ? regions[a % regions.length]!
              : paragraphs[a % paragraphs.length]!;
          json = [
            new AttrStep(
              target.pos,
              b % 2 ? 'policy' : 'id',
              b % 2 ? 'restricted' : simNodeId('h'),
            ).toJSON(),
          ];
          break;
        }
        case 3: {
          // A crafted replaceAround around a region: unwrap it into the body.
          if (!regions.length) return false;
          const r = regions[a % regions.length]!;
          json = [
            new ReplaceAroundStep(
              r.pos,
              r.pos + r.node.nodeSize,
              r.pos + 1,
              r.pos + r.node.nodeSize - 1,
              Slice.empty,
              0,
              true,
            ).toJSON(),
          ];
          break;
        }
        case 4: {
          // Bold the whole document in one mark step.
          json = [new AddMarkStep(1, size - 1, this.schema.marks['bold']!.create()).toJSON()];
          break;
        }
        case 5: {
          // Cheat on the base: ahead of the head, or far behind.
          const p = paragraphs[a % paragraphs.length]!;
          json = [
            new ReplaceStep(
              p.pos + 1,
              p.pos + 1,
              new Slice(Fragment.from(this.schema.text('b')), 0, 0),
            ).toJSON(),
          ];
          base = b % 2 ? this.confirmedSeq + 3 : 0;
          break;
        }
        case 6: {
          // Replay another user's commit identifier (04 §5 step 2).
          if (!this.seenIds.length) return false;
          id = this.seenIds[a % this.seenIds.length]!;
          const p = paragraphs[0]!;
          json = [
            new ReplaceStep(
              p.pos + 1,
              p.pos + 1,
              new Slice(Fragment.from(this.schema.text('r')), 0, 0),
            ).toJSON(),
          ];
          break;
        }
        case 8: {
          // A block suggestion in someone else's name on a paragraph of the restricted region, or a
          // node mark in someone else's name on an inline node (a tab put in first).
          const legal =
            paragraphs.find((p) => p.node.attrs['id'] === 'pLegal000000001B') ??
            paragraphs[a % paragraphs.length]!;
          const mark = this.schema.marks['del']!.create({ id: 'sForgedNodeMark1', user: 'carol' });
          if (b % 2) json = [addSuggestion(doc, legal.pos, mark).toJSON()];
          else {
            const at = legal.pos + 1;
            const tab = this.schema.nodes['tab']!.create();
            json = [
              new ReplaceStep(at, at, new Slice(Fragment.from(tab), 0, 0)).toJSON(),
              new AddNodeMarkStep(at, mark).toJSON(),
            ];
          }
          break;
        }
        case 9: {
          // Strip a mark from the whole document in one step, regions included.
          json = [
            new RemoveMarkStep(
              1,
              size - 1,
              this.schema.marks[b % 2 ? 'bold' : 'del']!.create(
                b % 2 ? {} : { id: 'sForgedSuggest01', user: 'carol' },
              ),
            ).toJSON(),
          ];
          break;
        }
        default:
          // Garbage: disallowed or malformed steps.
          json = [
            [{ stepType: 'docAttr', attr: 'x', value: 1 }],
            [{ stepType: 'replace' }],
            [{ stepType: 'nope' }],
            [],
          ][b % 4]!;
      }
    } catch {
      return false;
    }
    let sent: Step[];
    try {
      sent = (json as Array<Record<string, unknown>>).map((s) => Step.fromJSON(this.schema, s));
    } catch {
      sent = [];
    }
    if (!this.seenIds.includes(id)) this.created.add(id);
    this.inflight = { id, base, sent, json, local: [], needsResend: false };
    this.outbox.push({ t: 'submit', channel: this.channel, commit: { id, base, steps: json } });
    return true;
  }
}
