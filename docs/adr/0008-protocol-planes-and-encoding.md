# ADR 0008: Protocol shape: one multiplexed WebSocket, stateless REST, signed webhooks, JSON

**Status:** proposed, 2026-09-18.

## Context

The component and the backend must be very loosely coupled through a defined protocol that third parties can implement in any language (R6). Protocols examined on 2026-09-18 and the lesson taken from each:

| Protocol | Lesson |
|---|---|
| WOPI (Microsoft, also used by Collabora and ONLYOFFICE) | Discovery, opaque scoped tokens and a public validator are why independent implementations interoperate. Whole-file locking cannot express real-time editing |
| ONLYOFFICE callback API | Named events beat magic status numbers |
| CKEditor Cloud Services | Requiring the editor bundle on the server is the coupling to avoid |
| Hocuspocus | Its hooks are a Node.js library API, not a protocol; they are a checklist of extension points a protocol must cover |
| Liveblocks | Tokens that point at server-side permissions make live permission changes cheap |
| y-protocols | No versioning, acknowledgements, errors or limits; awareness is unauthenticated |
| automerge-repo, Loro protocol | Version negotiation in the handshake; typed rejection codes; fragmentation for large messages; separate network and storage adapters |
| LSP and MCP | Capability negotiation, a strict versioning discipline, conformance-gated changes; keep request and response stateless |
| Replicache, ShareDB | Idempotent client mutation identifiers; rejection that the client rolls back |
| CloudEvents and Standard Webhooks | Ready-made envelope and signing for webhooks |

Transport facts: WebSocket over HTTP/1.1 is the only universally available bidirectional transport; WebTransport reached all major browsers only in 2026; common gateways limit messages to 128 KiB and drop idle connections after 100 seconds to 10 minutes.

## Decision

- Five parts: discovery, a real-time plane on one multiplexed WebSocket, a stateless REST control plane, signed webhooks, and the embedding API (05).
- The socket carries only what needs a stateful connection: sync, presence, live permission changes and thin "this changed" notifications. Everything else is REST, which host backends can also call and which caches, gateways and idempotency keys already understand.
- Messages are JSON text frames with a small envelope. Binary frames are reserved for engines with opaque payloads.
- The sync engine is negotiated per channel.
- Initial content is loaded over HTTP; the socket carries changes only.
- Tokens are short-lived, scoped to documents and carry the document-level role. Region grants stay on the server.
- The prose specification is accompanied by AsyncAPI, OpenAPI and JSON Schema definitions and a black-box conformance kit with profiles. A second server implementation must pass the core profile before the protocol is frozen.

## Consequences

Good:
- Messages are readable in browser tools; one schema language covers every plane; no code generator is required to implement the protocol.
- A minimal backend is small: relay mode plus content storage.
- The component can run against the DEP client, a local backend or a mock, which proves the decoupling.

Bad:
- JSON is larger than a binary encoding. Commits are small and compress well, so this is accepted.
- Two connections (socket and HTTP) must be allowed by the network.
- The `pm-steps/1` payload is only meaningful to a backend that implements its semantics; the sidecar exists for that.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Everything over the socket | Host backends would need a socket client; no caching; awkward for large reads and uploads |
| Protocol Buffers | Good evolution rules and code generation, but harder to inspect and one more toolchain for implementers |
| The lib0 encoding of Yjs | Ties implementers to Yjs |
| JSON-RPC 2.0 verbatim | Its libraries stop helping once channels and binary frames exist; the envelope borrows its request and reply correlation |
| Socket.IO | Not a WebSocket-compatible protocol, which rules out independent servers |
| WOPI | Designed for whole-file editing sessions |

## After the first review (2026-09-18)

- "A minimal backend is small" was only half true. A relay cannot serve content, restore, comparison or export, so for backends not written in JavaScript the authority service is the real contract. Its interface is now normative, and the spec names three backend tiers and what each may announce.
- The join point between the content fetch and the live stream, the order of acknowledgements relative to coalesced commits, and the fate of an in-flight commit across a reconnect were loose enough for two implementations to disagree. They are now defined, with a caught-up marker, a resume handshake and a log incarnation.
- Chunking is part of the core, because the commit size limit exceeds the message size limit.
- Tokens carry a role per document, service credentials have their own type and keys, keys are selected by tenant registration, and revocation is remembered.
- `goaway` is for the connection only; rooms close channels. Session resumption was removed because it had no defined meaning.
- One error registry and one event vocabulary cover the socket, REST, webhooks and DOM events.
- The browser-facing HTTP rules (CORS, asset URLs for images) are normative.
- The conformance kit has a bootstrap contract and says what it cannot observe. The conformance programme grows with the roadmap, and the second implementation waits for a partner.

## Revisit when

Networks that block WebSockets become a common deployment problem (add the server-sent events binding), or message volume makes JSON size matter.
