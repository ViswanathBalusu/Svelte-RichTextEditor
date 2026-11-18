# 10 Security

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Informative summary; the binding rules are in the documents it points to.

## 1. What is protected

| Asset | Why it matters |
|---|---|
| Document content, history, comments, field values, assets | Confidential customer data |
| Integrity of parts a user may not change | The core promise of requirements R3 and R13 |
| Attribution and evidence | History and signatures are only useful if they cannot be forged |
| Sealed final documents | They are what people rely on afterwards |
| Tenant isolation | One customer must never reach another's data |
| The compile, import and asset workers | They process hostile input with powerful tools |
| Signing keys | A stolen key can seal anything |
| Availability | Editing is interactive |

## 2. Actors and trust

| Actor | Trusted for |
|---|---|
| Host backend | Identity, document-level role, group membership, how a participant was authenticated. It holds a service credential. It can mint any `sub`, so attribution is as strong as the host's authentication and no stronger |
| Host page | Holding the user's token. It can do whatever that user can do |
| Authenticated end user, including an external workflow participant | Nothing beyond their capabilities. Assume a user will send hand-crafted protocol messages |
| Other tenants | Nothing |
| Document content, pasted content, uploaded files, field values, prefill data | Nothing. Also untrusted as input to an assistant model |
| Workers and everything they produce | Nothing beyond their one job. Assume a worker can be fully compromised by the input it processes, and treat its outputs as hostile |
| The operator | Trusted to run the service. Tamper evidence that must hold against the operator needs chain heads anchored outside (08, section 12) |

Trust boundaries: host page to element (DOM API), element to document service (DEP), host backend to document service (REST with service credential), document service to workers (queue and object storage), document service to signing service, document service to host backend (webhooks).

## 3. Threats and mitigations

### 3.1 Editor component

| Threat | Mitigation |
|---|---|
| Script injection through document content | The CDM has no raw HTML, and every attribute has a grammar (invariant I11). The component builds DOM with DOM APIs |
| Script injection through paste | Pasted HTML is sanitised and then parsed through the schema, which drops everything the model does not know |
| Dangerous links | `link.href` allows `http`, `https`, `mailto` and in-document targets only (invariant I9). Links open with `noopener` and `noreferrer` |
| Hostile images | Images are never embedded as data. They are uploaded to quarantine, validated and re-encoded by the asset worker. SVG is never rendered as live SVG in the editor |
| A hostile PDF from a compromised worker | The viewer runs in a sandboxed cross-origin frame with script evaluation off |
| Token theft | Tokens live in memory only, are never put in URLs, last at most 15 minutes and are scoped to documents. The journal in IndexedDB holds commits, never tokens |
| Strict host policies | Content security policy and Trusted Types requirements are published per feature; the component is built without HTML-string templates (02, section 3). Verified in spike S2, for every dependency |
| Global side effects on the host page | Fonts are registered under hash-derived aliases; shortcuts fire only inside the editor; a second version of the element is detected and reported |
| Leaking content to the host page by accident | Events carry identifiers and counts, not content. Content leaves only through explicit methods |
| Prompt injection through document text | 13, section 6.2: untrusted text is marked as data, side effects need approval, model output arrives only as suggestions and only as escaped text |

An open shadow root is not a security boundary. The host page can read it. That is acceptable: the host page already holds the user's token.

### 3.2 Protocol and gateway

| Threat | Mitigation |
|---|---|
| Cross-site WebSocket use | The origin is checked against the tenant's allow-list at `hello`. Authentication is a bearer token, not a cookie |
| Cross-site request forgery on REST | Bearer tokens only; no cookies. CORS is limited to the tenant's origins |
| Cross-tenant token confusion | Keys are selected by tenant registration, never from a URL in the token; asymmetric algorithms on an allow-list; exact audience; service credentials have their own token type and keys (05, section 3) |
| A token that covers many documents with one role | The `docs` claim gives a role per document |
| Reconnecting after revocation | A revocation watermark refuses older tokens on both planes |
| Replay and resubmission | Commit identifiers are unique per document and bound to the submitting user, and duplicates are recognised even while the first copy is still being stored |
| Taking over another caller's job through a reused idempotency key | Keys are scoped to tenant, caller, route and body hash |
| Reaching someone else's thread, export or asset by its bare identifier | Every such resource is resolved to its document and checked against the token |
| Oversized or malformed messages | Size limits, strict envelope parsing, close codes; the envelope parser is fuzzed |
| Resource exhaustion | Limits per address before authentication, then per connection, user and tenant; presence validated and capped; bounded send queues; admission control on commits |
| Identity spoofing | The server stamps user and session on commits, presence and threads. Client-supplied identity fields are checked or ignored; the client's `origin` is recorded only as a claim |
| Forged webhooks | Standard Webhooks signatures with timestamp tolerance and secret rotation |
| Server-side request forgery through webhook targets | An egress proxy refuses private and link-local addresses |

### 3.3 Authority

| Threat | Mitigation |
|---|---|
| Changing a part of a document without permission | The outcome check of 07, section 5.1, which compares the document before and after a commit and does not depend on the shape of steps |
| Defacing protected text through shared styles | 07, section 5.3 |
| Bypassing validation through rebase tricks | Only mapped steps are applied, and they pass every check |
| Editing under permissions that were just revoked | The log write is conditional on the grants revision (04, G7) |
| Corrupting the document | Schema, invariant and attribute-grammar checks on every commit, for every step type; step types limited to an allow-list |
| Stalling or crashing a process that hosts many rooms | Admission control before any work; CPU budgets per connection; heavy work in worker threads; structural limits; fuzzing of the authority |
| Forging history | Server-side attribution; a hash chain that includes permission and workflow changes; chain heads published to hosts and anchored in write-once storage |
| Changing an approved region | Approvals are bound to a sequence number and a content hash, and no commit of any origin may change an approved region (07, section 11) |
| Two writers | Epoch-checked writes and the log's primary key; self-fencing on the node lease (06, section 2.1) |
| Reading deleted text through old versions | One visibility gate on every sequence number a caller can supply (07, section 8) |

### 3.4 LaTeX workers

The rules are in 09, sections 4, 6.3 and 9.3. In short: only machine-generated LaTeX; typed emitters for every context in which a user's string can reach TeX, with generated identifiers; grammars on every attribute; a strict gate on math that also stops content painted outside its box; no shell escape; paranoid file access; a current LuaTeX; no network; a single-use sandbox per job; no reuse of auxiliary files; hard limits; no credentials; outputs treated as hostile; two independent compiles before sealing. LaTeX injection is treated like SQL injection: escaping is not optional and is tested adversarially, and the sandbox assumes the escaping will fail one day.

### 3.5 Asset and import workers

| Threat | Mitigation |
|---|---|
| Overwriting or claiming an asset by declaring its hash | Uploads go to quarantine; the worker computes the hash and alone writes the final object |
| Referencing an asset one never uploaded to gain read access to it | A document may reference only assets attached to it (invariant I4; 06, section 4.4) |
| Decompression bombs | Limits on entries, sizes and ratios for archives; pixel limits for images |
| XML external entities | Document type declarations are rejected |
| Remote content in DOCX | External relationships are never followed |
| Macros and embedded objects | Macro-enabled files are refused. Embedded objects are kept as opaque preserved content: never parsed, run or rendered, and written back unchanged on DOCX export (ADR 0017; 09, section 12) |
| Decoder exploits | Decoding happens in a sandboxed worker without network or credentials; output is re-encoded |
| Content-type confusion | The declared type must match the detected type; assets are served with fixed content types and `nosniff` from a separate origin |
| Impersonation through imported tracked changes | Imported authors become labels, never user identities |

### 3.6 Signing and evidence

| Threat | Mitigation |
|---|---|
| Stolen signing key | Keys live in a hardware security module or key service; the signing service is separate from every worker that touches user content |
| A tampered PDF being sealed | Two independent compiles are compared first; the bundle is pinned to a sequence number and chain head |
| Claims about signer identity the platform cannot support | The platform records the host's authentication claims and never vouches for identity; product language follows 12, section 8.3 |
| Evidence leaking or outliving its purpose | Evidence is kept outside the log with its own retention; only salted hashes enter the chain |
| A filler changing more than their fields | Rules P7 to P9, checked by the same outcome check |

### 3.7 Data and tenancy

- Row-level security and a tenant identifier on every table that holds tenant data (not `node_leases`: 06, section 4.1), and on every object path and cache key; per-tenant encryption keys; optional dedicated deployments.
- Signed URLs are short-lived, scoped to one object, and issued only after a permission check.
- Logs and metrics never contain document content or tokens. Support works from structural dumps without text (06, section 11).
- Secrets are held in a secret manager and rotated. Webhook secrets and service credentials have overlap periods for rotation.
- Backups are encrypted and access to them is audited.

### 3.8 Supply chain

Lock files, dependency review, a software bill of materials per release, signed container images, pinned base images, and a pinned TeX Live with a licence manifest. The editor bundle loads no code at run time from third-party origins. Sandboxed third-party extensions (phase 4; ADR 0393) are an explicit exception with their own review (13, section 7.2). The terms of the exception, and the first review of the sandbox, are in `docs/review/2026-11-18-ux-060-sandbox-review.md`: the extension's code runs only in a sandboxed frame with an opaque origin and no network, the host chooses what is installed, and the code of an extension is not part of the release's bill of materials.

## 4. Privacy

- The document service knows users as per-tenant surrogate identifiers plus an optional display name that can be purged. Erasing a user deletes the mapping row; hosts are asked not to use e-mail addresses as identifiers.
- Data stays in the tenant's home region (06, section 7).
- Deletion and retention are covered in 08, sections 11 and 13; evidence in 12, section 7.
- End-to-end encryption is a non-goal: the server must read documents to enforce permissions, keep history and typeset.

## 5. Security testing

| Activity | Target |
|---|---|
| Fuzzing | Envelope parser, step validation and rebase, the typed emitters per context and language, the math gate, the rules evaluator, the DOCX importer |
| Property tests | The outcome check: no sequence of commits from a user changes a scope outside their writable set. The same for fill-only participants and suggestion-only users |
| Negative conformance tests | One per row of the authorisation matrix (07, section 12) and one per rejection code |
| Adversarial sandbox tests | File reads, network, process execution, memory and time exhaustion from inside a compile |
| Review | A threat-model review at the end of each roadmap phase and an external penetration test before general availability |

## 6. Open issues

- A policy for browser extensions that read or modify editor content (grammar checkers, translators). They run with the user's privileges and cannot be prevented, but their edits arrive as ordinary input and pass the same checks.
- Abuse handling for hosted mode (malware distribution through assets, phishing documents) needs an operational policy.
- Key management details for per-document encryption keys and for tenant-owned sealing keys.
- Whether chain heads should also be anchored in a public transparency log.
