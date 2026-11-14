# Pitfall and improvement review, 2026-09-18

This records the first independent review of the specification (draft 0.1), what it found, and what was changed in response (draft 0.2).

## 1. How the review was run

Eight review agents read the repository in parallel. None could modify files. Six looked for pitfalls and improvements through one lens each; two compared the spec with a product expectation that arrived after draft 0.1 was written: the editor should feel like Microsoft 365 and offer DocuSign-style filling under customizable rules, as an all-round package.

| Reviewer | Lens | Checked against |
|---|---|---|
| Sync | Convergence, interleavings, fencing, scaling | Source of prosemirror-collab, prosemirror-transform and prosemirror-collab-commit |
| Security | Permission bypass, tokens, LaTeX, side channels, abuse | prosemirror-transform step sources; LuaTeX advisories; the PDF.js advisory |
| Frontend | Browser platform, Svelte, ProseMirror schema, accessibility | Svelte and ProseMirror source, MDN, caniuse, WCAG 2.2 |
| Protocol | Ambiguity, completeness, consistency between documents | The spec itself, line by line |
| Model and LaTeX | Model gaps, package feasibility, tagging | CTAN package sources, the LaTeX tagging status list, ProseMirror source |
| Product | Scope, sequencing, operations, legal | The spec and the research summary |
| Microsoft 365 gap | What "feels like 365" means in 2026 | Microsoft's service description and support pages |
| Fields and rules | How e-signature products work; a design for this architecture | Vendor developer documentation, eIDAS, ESIGN, PAdES, RFC 3161 |

**Caveat.** The changes made in response have not themselves been reviewed. A second pass is recommended once the owner has taken the decisions in 11, section 10.

## 2. Summary

- The six pitfall reviewers reported 91 pitfalls: 8 critical, 37 high, the rest medium or low. Several were the same problem seen through different lenses.
- The eight critical findings merge into six:
  1. **No place for fillable fields.** Four reviewers independently found that regions cannot express "Name, Date, Signature" blanks, and that nothing covered roles, rules, workflow or sealing. Answer: a new document, [12](../spec/12-fields-rules-workflow.md).
  2. **The permission check could be bypassed.** It reasoned about the ranges a step touches, but attribute and mark steps have empty position maps. Answer: compare the document before and after a commit, scope by scope (07, section 5.1).
  3. **A lost notification could leave a revoked user able to write.** Answer: the log write is conditional on the grants revision (04, G7).
  4. **"Any backend can implement it" was not true for relay backends**, and the step semantics were not pinned tightly enough for an independent authority. Answer: honest backend tiers, a normative authority service interface, an exact library pin, a published schema and a defined canonical form (05, sections 9 to 11; 04, section 4; 03, section 2).
  5. **The hidden input element of the page view had three conflicting jobs.** Answer: the design is reopened as spike S9; the continuous view becomes permanent.
  6. **Phase 1 was most of the product.** Answer: phases 1a and 1b, a borrow list, and a gate before the page view.
- The reviewers also confirmed things. The server-side rebase procedure is index-for-index equivalent to ProseMirror's own. The log's primary key is a sufficient fence on one primary. Constructable stylesheets and `element.style` assignments are exempt from content security policies in practice. The LuaTeX security claims hold, with one correction: shell execution and default sockets were two separate vulnerabilities.

## 3. Findings and dispositions

"Fixed" means the spec was changed; the location is given. "Open" means the finding is accepted and recorded as an open issue or a spike.

### 3.1 Sync and distributed systems

| ID | Sev. | Finding | Disposition |
|---|---|---|---|
| PERM-1 | Critical | Grant changes reach the room only as an announcement; nothing at write time checks the revision; no timers for expiries | Fixed: 04 G7 and section 5; 06, 2.3; 07, sections 4 and 9 |
| SYNC-1 | High | Deduplication missed commits still waiting to be stored; one user could crash a room by sending an identifier twice | Fixed: 04, section 5, steps 1 and 2; 06, 2.3 |
| TENT-1 | High | "Reset to the durable head" was undefined; unknown write outcomes; checkpoints from tentative state | Fixed: 04, section 5; 06, 2.2 and 2.3 |
| CONV-1 | High | Removing steps with stored inverses is not exact for mark steps | Fixed: 04, section 7 (the confirmed document) |
| DR-1 | High | A database recovery can rewind sequence numbers | Fixed: log incarnation (04, sections 1 and 9); recovery objectives (06, section 9) |
| ROUTE-1 | High | Sockets open before the document is known, so forwarding was the normal path, even in stage 1 | Fixed: stage 1 is one process; connect hint and reliable streams from stage 2; acknowledgement timeout and gap rule on the client |
| MIG-1 | High | A migration cannot be a list of steps, and ran on first open during a rollout | Fixed: snapshot commits; operator-gated migrations; exact pin (03, 11.3; 04, sections 3.2 and 4) |
| PROTO-1 | Medium | Six loose rules about ordering, heads and resubmission | Fixed: 04, sections 5, 8 and 9; 05, sections 4 and 5 |
| SRV-1 | Medium | Server-authored commits were a dual write and skipped the permission check | Fixed: outbox, deterministic identifiers, preconditions re-checked, transient authority (04, section 10) |
| CPU-1 | Medium | The time budget could not pre-empt synchronous work | Fixed in the spec: admission control and worker threads (04, section 12). Needs measurement |
| LEASE-1 | Medium | Whose clock; no self-fencing; viewers on a partitioned host | Fixed: 06, 2.1 |
| RELAY-1 | Medium | A relay cannot serve content; one bad step bricks a document | Fixed: 04, section 14; 05, sections 9 and 10 |
| TIME-1 | Medium | The five-minute check on suggestion times drops work after a laptop sleeps | Fixed: marks carry no time (03, section 5) |
| PRES-1 | Low | Presence positions included unconfirmed text | Fixed: 04, section 11 |

Improvements adopted: control commits for permission and workflow state; exclusive fills per field; the resume handshake; snapshot commits; serving content at the nearest checkpoint; a slimmer write path; authorisation evidence per commit. A rolling document hash is recorded as an open issue.

### 3.2 Security and permissions

| ID | Sev. | Finding | Disposition |
|---|---|---|---|
| S-01 | Critical | Range-based scope rules miss attribute, mark and node-mark steps; the top level of the tree had no scope | Fixed: the outcome check, the `doc` scope, invariant I11 (07, section 5; 03, section 8) |
| S-02 | High | Approvals were labels not bound to content; server-authored commits skipped checks; permission changes were outside the hash chain | Fixed: 07, section 11; 04, section 10; 08, sections 2 and 12 |
| S-03 | High | Protected text could be restyled through shared definitions, or overpainted by an equation | Fixed: 07, section 5.3; 09, section 6.3 |
| S-04 | High | Revocation did not persist; session resume undefined | Fixed: revocation watermark; session resume removed (05, section 3.3) |
| S-05 | High | One role for up to 20 documents; service credential by claim; key selection unspecified | Fixed: 05, sections 3.1 and 3.2 |
| S-06 | High | User strings reach TeX in many contexts besides body text; a client could backdate the `date` field | Fixed: typed emitters, generated identifiers, attribute grammars, server dates (09, sections 3 and 4) |
| S-07 | High | Expensive commits stall a shared process; presence unbounded; no limit before authentication | Fixed in the spec: 04, sections 11 and 12; 06, section 1 |
| S-08 | Medium | History visibility bypassed through other endpoints and through channel resume | Fixed: one gate (07, section 8) |
| S-09 | Medium | Tables without tenant identifiers; resources by bare identifier; idempotency keys shared between callers; webhook request forgery | Fixed: 06, 4.1; 05, sections 6.1 and 7 |
| S-10 | Medium | Client-declared asset hashes; asset references not an invariant; imported authors | Fixed: 06, 4.4; invariant I4; 07, section 15 |
| S-11 | Medium | Comment anchors could be moved or deleted by any editor; a gap between authorisation and application | Superseded: comments left the document ([ADR 0015](../adr/0015-comments-as-mapped-ranges.md)) |
| S-12 | Medium | Worker outputs were trusted: the PDF viewer in the host origin, reused auxiliary files, logs | Fixed: 09, sections 8 and 9.3 |
| S-13 | Medium | Suggestion identifiers could be reused; marks of one type replaced each other | Fixed: 03, section 5; rule P4 |
| S-14 | Medium | Host user identifiers, often e-mail addresses, were in the immutable chain | Fixed: per-tenant surrogates; payload tombstones (08, section 13) |
| S-15 | Low | An editor could lock colleagues out through region policy; identifiers resurrecting grants; endless leases | Fixed: 07, sections 2, 3 and 10. A per-region size quota is open |

Improvements adopted: all eight, including the authorisation matrix (07, section 12). Anchoring chain heads in a public transparency log is open.

### 3.3 Frontend

| ID | Sev. | Finding | Disposition |
|---|---|---|---|
| F1 | Critical | The input bridge cannot be accessibility tree, input-method anchor and key handler at once; `prosemirror-view` has no EditContext support | Open: spike S9; 02, section 9.6 |
| F2 | High | No fields; passive painted pages could not host controls | Fixed: 12; an interactive overlay layer in the painter |
| F3 | High | The first view cannot feel like Word, and its page guides drift | Fixed by reframing: three views, "Web layout" is permanent, real pages come from the PDF first (02, section 7) |
| F4 | High | Trusted Types and policy claims were wrong for Svelte, ProseMirror, the math editor and the PDF viewer | Fixed: 02, section 3; spike S2 widened |
| F5 | High | A required `id` disables ProseMirror's node creation | Fixed: null default, checked at the end of a commit |
| F6 | High | Lifecycle leaks; property timing in frameworks; silent version collisions; server import | Fixed: 02, sections 2 and 2.1 |
| F7 | High | Unconfirmed work lived only in memory; `pagehide` is unreliable | Fixed: the journal (02, 2.2; 13, section 9). A REST commit endpoint is open |
| F8 | Medium | Fonts registered on the document are global to the host | Fixed: hash-derived aliases |
| F9 | Medium | Canvas cannot control ligatures, nor kerning in Safari | Fixed: the painter follows canvas; spike S5 also evaluates HarfBuzz |
| F10 | Medium | "Select all" and similar commands reach definitions and stories | Fixed: 03, section 3; 02, 5.2; spike S1 widened |
| F11 | Medium | Zero-width anchors create invisible cursor stops | Fixed for comments by ADR 0015; bookmarks keep anchors |
| F12 | Medium | No place for the caret between adjacent regions | Fixed: a body paragraph after every region |
| F13 | Medium | Block-level suggestion marks break table layout | Fixed and limited: decorations, own table commands, whole rows only |
| F14 | Medium | The accessibility claim was thin | Fixed in the spec: 02, section 10; 13, section 8 |
| F15 | Low | Printing from a shadow root; misattributed browser floor; clipboard formats | Fixed: 02, sections 8, 9.8 and 5.2 |

### 3.4 Protocol

| ID | Sev. | Finding | Disposition |
|---|---|---|---|
| PR-1 | Critical | Relay mode cannot serve the protocol; the sidecar was the real, unspecified contract | Fixed: 05, sections 9 and 10 |
| PR-2 | Critical | `pm-steps/1` not pinned; canonical form undefined | Fixed: 04, section 4; 03, section 2 |
| PR-3 | High | Join point undefined without a resume or on reload | Fixed: 05, section 5.2 |
| PR-4 | High | Acknowledgements against coalesced commits; rejection without a head | Fixed: 04, section 5; 05, section 5.3 |
| PR-5 | High | Token lifecycle holes | Fixed: 05, section 3 |
| PR-6 | High | No protocol home for fill and sign | Fixed: 12, section 10 |
| PR-7 | High | Commit limit above message limit with optional chunking; no reset message | Fixed: chunking in the core; `sync.reset`; all limits advertised |
| PR-8 to PR-13 | Medium | Error catalogue; `goaway` overloaded; `access` semantics; CORS and asset URLs; conformance bootstrap; host document lifecycle | Fixed: 05, sections 5.1, 5.5, 5.8, 6.1, 6.2 and 11; 13, section 11 |
| PR-14 | Medium | Backend ports were a sketch; the local backend proves less than claimed | Partly: ports listed and the claim corrected; full typings are a phase 0 deliverable |
| PR-15 | Medium | Name and shape drift across documents | Fixed: one vocabulary for events, states, leases, versions of `cdm`, envelope fields |
| PR-16 | Medium | Embedding API too thin | Partly: command state, content insertion, views, print and a version were added; slots come through extension contributions; a shared connection is open |

### 3.5 Document model and LaTeX

| ID | Sev. | Finding | Disposition |
|---|---|---|---|
| M-1 | Critical | No fillable fields, and adding a node type later breaks old readers | Fixed: field, role, rule and extension nodes are reserved in version 1 |
| M-2 | High | The package mapping contradicted tagged PDF | Fixed: a tagging-first class (09, section 3.1) |
| M-3 | High | `longtable` cannot split rows or live in columns, headers or footnotes | Fixed: three table writers (09, section 3.2) |
| M-4 | High | Numbering had no list identity and three engines | Fixed: `listId`, numbering in styles, one algorithm, literal labels (03, sections 4.3 and 7) |
| M-5 | High | "Preserve what you do not understand" is impossible on ProseMirror | Fixed: `requires` and `ext` (03, section 11) |
| M-6 | High | The schema admitted content LaTeX cannot typeset | Fixed: invariant I10, converter downgrades, a shared preflight |
| M-7 | High | One escaper is not enough; language modules rewrite text; missing glyphs vanish | Fixed: 09, sections 3 and 4 |
| M-8 | High | Page reconciliation under disagreement was undefined; level L2 fragile | Fixed in the spec: line-level `layout.json`, an overflow rule, L2 marked experimental |
| M-9 | Medium | The math gate passed input that breaks compiles or paints outside its box | Fixed: 09, section 6.3 |
| M-10 | Medium | Reusing auxiliary files breaks reproducibility and caching | Fixed: no reuse |
| M-11 | Medium | Structural model gaps | Partly: captions with sequences, block comment targets, formatting suggestions on blocks. The footnote content model is open for spike S1; endnotes are excluded |
| M-12 to M-14 | Medium | Section and header mapping; cost figures; vertical spacing | Fixed: 09, section 3.1 and 8; 03, section 7 |
| M-15 | Medium | Word matches editable ranges by e-mail; math converter licences | Fixed: opt-in export identities; a converter spike |
| M-16 | Low | Identifier on the wrong half of a split; style identifier collisions; restore needing deleted definitions | Fixed: 03, sections 4.1 and 9; 07, section 13 |

### 3.6 Product, scope and operations

| ID | Sev. | Finding | Disposition |
|---|---|---|---|
| PD-1 | Critical | Regions cannot express DocuSign-style fields | Fixed: 12 |
| PD-2 | Critical | Phase 1 was most of the product | Fixed: phases 1a and 1b |
| PD-3 | High | Build-versus-buy for the page view was not honest | Fixed: spike S7, a gate after phase 2 |
| PD-4 | High | The assumptions are not independent; the CRDT "fallback" is unreachable | Fixed: 00, section 5; ADR 0001 |
| PD-5 | High | Durability and availability targets contradicted a one-node stage | Fixed: stated recovery objectives and incarnations |
| PD-6 | High | No cost model; previews and the log are the big costs | Fixed in the spec: 06, section 10. The sheet itself is a phase 0 deliverable |
| PD-7 | High | Schema migration ignored hosts that pin old components | Fixed: operator gating and an n-1 window |
| PD-8 | High | Nobody owns the legal questions | Accepted: a legal note in phase 0; Apache-2.0 recommended. Needs counsel |
| PD-9 | High | DOCX import was in phase 4 although real use starts with an upload | Fixed: phase 2; the original file is kept |
| PD-10 | Medium | The conformance programme was on the critical path with no customer | Adopted: see section 4 |
| PD-11 to PD-14 | Medium | Disconnection tolerance; untestable targets; operations sketch; missing surface | Fixed or partly fixed: the journal and paged catch-up; 13, section 9; 06, sections 11 and 13; 13, sections 10 and 11. On-call and abuse processes are open |
| PD-15 | Low | Contradictions between documents | Fixed |

### 3.7 Gap analyses

- **Microsoft 365.** The benchmark is Word for the web. The gaps were the shell, commands, keyboard model, collaboration header, mentions and tasks, proofing, an assistant, extensions, governance. All are now in [13](../spec/13-experience-extensibility.md), with a parity profile that says what is built in, what comes through ports and extensions, and what is a non-goal.
- **Fields and rules.** The proposal was adopted almost whole as [12](../spec/12-fields-rules-workflow.md), with two changes: fills are exclusive per field, and comments stay available during a workflow because they no longer change the document.

## 4. Where reviewers disagreed

| Question | Positions | Resolution |
|---|---|---|
| When to build a second server implementation | Protocol: in phase 1, to prove loose coupling. Product: not until a partner exists | Deferred. Schemas, port contract tests, fixtures and a smoke suite come early; the protocol is frozen at 1.0 only after a second implementation passes |
| Reusing auxiliary files | Model: reuse after validating against a grammar. Security: never | Never, in version 1 |
| How to anchor comments | Frontend: marks or mapped ranges. Security: restrict who may touch anchors. Fields: disable comments during workflows | Mapped ranges kept by the service (ADR 0015), which answers all three |
| Who may fork a document | Convenience says users; the protocol reviewer says the host must know about every document | Service credential only; the component raises an event for the host |

## 5. Owner clarification after the review

The review agents were briefed that the editor should "feel like" Microsoft 365, and two of them warned about imitating Microsoft's look (finding PD-8 and the Microsoft 365 gap analysis). The owner then clarified: the project is not imitating Microsoft 365; it wants the same features. The spec was changed accordingly:

- Microsoft 365, specifically Word for the web, is a feature benchmark. Parity is judged by what a user can do, never by appearance (00, requirement R14; 13, sections 1 and 2; [ADR 0014](../adr/0014-experience-benchmark-and-extensions.md)).
- The interface, including how commands are grouped and drawn, is the product's own design. The word "ribbon" was replaced by neutral terms.
- The look-alike concern no longer applies. What remains of finding PD-8 is the project's name, ordinary trademark care in marketing, the licences inside the distributed TeX Live image, fonts, and e-signature wording.
- A new risk was recorded instead: a feature checklist does not produce a good interface, so the project needs design work of its own (11, risk 16).

## 6. What remains open

1. The owner's decisions in 11, section 10, above all A1, A2 and A4.
2. The input bridge and screen-reader plan of the page view (spike S9), and whether the page view is built at all.
3. The footnote content model, before the document model is frozen.
4. Legal review: the project's name, licences in the distributed image, e-signature wording.
5. Measurements that the spec can only estimate: compile cost with tagging, memory per open document, log volume, admission-control budgets.
6. Precise suggestion rules for block-level changes beyond paragraphs and whole rows.
7. A second review pass over draft 0.2.
