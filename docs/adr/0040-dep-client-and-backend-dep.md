# ADR 0040: The DEP client: state machines in `protocol`, the ports over DEP in `backend-dep`

**Status:** proposed, 2026-11-06. Records the choices made while building the client side of DEP (PLAN-1a packet B3: PRO-004, PRO-005, PRO-006, PRO-093, PRO-094). The choices that change what travels on the wire are in the protocol's decision register as D80 to D85 (`packages/protocol/src/definition/decisions.ts`, listed in the S6 report); this record holds the structure and the choices inside the client. The project owner has not reviewed any of it.

## Context

05 §4 and §5 define the frames, 04 §8 and §9 the client's algorithm, and the port typings of spike S6 (`packages/protocol/src/ports`) what the editing core sees. Several things a client needs are left open:

- who resumes a channel after a lost connection, the backend or the editing core, although the port typings already name a `resuming` state (D20) and PRO-095 puts the resume in the port;
- what a resume answered with `reload` means at the port, where there is no way to hand over new content and the reasons of `sync.reset` are a closed enumeration (D01);
- how a backend reports the connection for `de-status` (05 §8.1): no port member carries it;
- how the view token of ADR 0019 reaches a resume that the caller builds from a content read (G101);
- which requests time out, and what a client does with frames that a faulty intermediary loses or repeats.

The client must run in browsers and in Node.js unchanged, with no platform API beyond the ones it declares (FND-004).

## Decision

### 1. Two layers

- **`@docedit/protocol/client`** holds the client state machines, which do no I/O: a driver passes in received frames and the time, and acts on what they return. `ClientSession` is one connection from `hello` to its end: the handshake and negotiation, unknown and invalid frames, the heartbeat, chunks. `ClientChannel` is one document channel: opening and catching up in the three modes, the order of commits and acknowledgements, and resuming. Negotiation (`negotiate.ts`) and reconnection (`backoff.ts`) are plain functions. The conformance kit and any other client can use them as they are.
- **`@docedit/backend-dep`** is the driver: the platform WebSocket, `fetch` and timers, declared minimally in `src/platform.ts`, found on `globalThis` at run time and replaceable in tests; the REST client; and the port objects. A channel's callbacks go through `OrderedDelivery`, so `backend-dep` keeps the delivery rules of D21 exactly as `backend-mock` does. Every timer goes through one `Timers` object, so `close()` can cancel every one and a test can check that none remains.

### 2. The backend resumes channels (D80)

After a gap, a duplicate, an answer that did not come within `ackTimeoutMs`, a lost connection, or `ch.closed` with `unavailable` or `slow_consumer`, the channel resumes by itself with `resume: { seq, incarnation, inflight, view }`. The caller keeps its `SyncChannel`: the state goes `resuming`, then `catching_up` and `live`; commits arrive in order, each once. Unanswered submits fail with `unavailable` (D23), and their commit is named in `resume.inflight`; if it was stored, it reaches the caller in the catch-up stream, which the editing core treats as the acknowledgement (SYN-019); if not, the core resubmits it with the same `id` once the channel is live, and the authority stores it once (04 §5 step 2). Submits made while the channel is not live wait until it is (04 §9 step 5). The port does not serialise submits: one commit in flight is the editing core's rule, and the server's `busy` answers a second.

The alternative, closing the channel and leaving every resume to the editing core, would make each core repeat the same work and would contradict D20 and PRO-095.

### 3. A reload closes the channel

When a resume is answered with `reload`, the confirmed document must be replaced (04 §9 step 3; ADR 0019 change 1). The port has no way to hand over new content, and `sync.reset` names snapshot commits with a closed list of reasons. So the channel sends `ch.close` and reports `closed` with code `unavailable`, `retryInMs: 0` and a reason that says so; the caller reopens the channel and reads the content as for any open. An editing core that reopens a closed channel, which it must do for `ch.closed` anyway, therefore needs nothing more. This mirrors ADR 0019 change 6, where a change of access is a close and a forced reload.

The alternative is a `reload` status in `ChannelState`, a change of the port typings (open question 1).

### 4. The connection status (D85)

`backend-dep` reports `online`, `reconnecting` or `offline` through `backend.connection` (`status` and `onStatus`), outside the port typings. The channels report `resuming` meanwhile, so an element that receives another backend can still tell a reconnection from the channel states. Adding an optional `connection` member to `Backend` is open question 2.

### 5. View tokens (D81)

The client keeps the view of every `ch.opened` and every content read (D28, D70), by document, with the incarnation and the range of `seq` it saw under that view. A channel resumes with the view of its latest `ch.opened`. A resume the caller passes without a view gets the one noted for its incarnation and `seq`, so that a caller that follows 05 §5.2 (content over REST, then a resume at its `seq`) works under read restrictions without handling tokens. A resume from content the client did not read in this session is sent as given, and a server with read restrictions reloads it, which is safe: the client cannot know which projection that content was.

### 6. Tokens

Tokens are held in memory only and travel in `hello`, `auth.refresh` and `Authorization: Bearer` headers, never in a URL (05 §3.1). REST calls before a session use one token from `getToken`, kept for the next calls. A refused token is replaced once by a new one from `getToken`, on the socket and over REST (05 §5.8); a failing token source raises `onAuthRequired` and rejects with `unauthenticated`. On `auth.expiring` the backend refreshes by itself and reports the event.

### 7. Timeouts and faults

- `ackTimeoutMs` (default 15,000, 04 §8) bounds every request: `hello` (the previous session's value, or the default), `ch.open`, `sync.submit`, `auth.refresh`, and a catch-up stream that falls silent before `sync.caughtUp`.
- The heartbeat is 05 §4's: `ping` after `heartbeatMs` without sending, and the connection is closed and reconnected after two intervals without a message.
- A frame lost on a live connection is noticed only through later traffic: a later commit shows the gap, a missing answer times out. A real socket loses frames only with its connection, so this matters only behind a faulty intermediary; the property tests model it and show that one later commit or edit recovers.

### 8. Defaults

- `backend-dep` asks for `presence`, `regions` and `suggest-enforced`, whose client side it implements. A host whose editor reads CDM features (03 §11) adds them in `features`, so that documents requiring them can be opened.
- `connect()` makes one attempt and rejects with the code: discovery that cannot be read is `unavailable`. Reconnection with the backoff of 05 §4 starts only after a session was open (D83).
- Channel numbers are never reused on a backend (G13): a counter, not a pool.
- The presence port is present while `presence` is negotiated, and the region members of the permissions port while `regions` is (D24); a state larger than `presenceBytes` is never sent, and updates are coalesced to `presenceHz`.

### 9. How it is tested

- The state machines: unit tests and fast-check properties against a model server that drops and repeats frames, loses the connection, lets answers time out and changes the reader's view (`packages/protocol/src/client/*.universal.test.ts`).
- `backend-dep`: an in-memory network that records every frame and request, to a DEP server built on `backend-mock`, which runs the real authority; the port contract and the smoke suite of the `core` profile run over it in Node.js and in the three browser engines. The same suites run over real sockets in Node.js, and against the document service started in process (`packages/backend-dep/test/`). An end-to-end property test puts two writers on the authority through `backend-dep` while the network cuts connections and drops or repeats frames.

## Consequences

Good:

- One implementation of the client algorithm for every client of the project, testable without a network or a clock.
- The editing core sees an ordered, gap-free stream and a stable `SyncChannel` across reconnects; the only reload it handles is the one any open can bring.
- Nothing in the package needs a Node.js or browser-only API.

Bad:

- A reload costs one more round trip: the close, then the caller's open.
- The connection status is outside the port typings until open question 2 is settled.
- `backend-dep` takes more of the client's work than 05 §8.3 states, so another backend that wants the same behaviour must use the same machines or repeat them.

## Open questions

1. Whether `ChannelState` should gain a `reload` status, so that a resume answered with `reload` keeps the channel open and hands the caller a `seq` to read (section 3).
2. Whether `Backend` should gain an optional `connection` member for `de-status` (section 4).
3. A resumed channel restarts `access.rev` at 1 (D12 counts per channel). The port delivers it as received; renumbering at the port would make it monotonic per `SyncChannel`.
4. D27 says a channel's first state is `live` for any catch-up mode but `stream`; with `page` the channel reports `catching_up` until it reaches the head (D80, and ADR 0034 section 1).
5. Whether clients see the token `sub` or the per-tenant surrogate as user identifiers (G11). The reference service sends surrogates today; the contract suite expects the `sub`.
