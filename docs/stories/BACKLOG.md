# Backlog by phase

Generated on 2026-11-18 from the epic files in this folder; regenerate it whenever a story's fields change. 1003 stories. Within a phase, stories are ordered by priority, then by epic in build order (foundations, decisions and spikes, model, sync, permissions, protocol, backend, security, frontend, shell, history, export, fields and workflow, WebAssembly). Order within a phase is not a dependency order: each story's **Depends on** line is.

## Phase 0: decisions, spikes and notes (47)

| Story | Title | Type | Size | Priority |
|---|---|---|---|---|
| [FND-001](FND-foundations.md#fnd-001-monorepo-with-the-package-layout-of-the-architecture) | Monorepo with the package layout of the architecture | enabler | M | must |
| [FND-002](FND-foundations.md#fnd-002-continuous-integration-across-the-supported-browsers) | Continuous integration across the supported browsers | enabler | M | must |
| [FND-006](FND-foundations.md#fnd-006-shared-document-corpus) | Shared document corpus | enabler | M | must |
| [FND-007](FND-foundations.md#fnd-007-reference-machine-and-client-performance-harness) | Reference machine and client performance harness | enabler | M | must |
| [SPK-001](SPK-phase0.md#spk-001-decide-assumption-a1-offline-first-editing) | Decide assumption A1: offline-first editing | decision | S | must |
| [SPK-002](SPK-phase0.md#spk-002-decide-assumption-a2-lossless-docx-round-trip) | Decide assumption A2: lossless DOCX round-trip | decision | S | must |
| [SPK-003](SPK-phase0.md#spk-003-decide-assumption-a3-one-house-latex-class) | Decide assumption A3: one house LaTeX class | decision | S | must |
| [SPK-004](SPK-phase0.md#spk-004-decide-assumption-a4-latex-as-an-export-pipeline-only) | Decide assumption A4: LaTeX as an export pipeline only | decision | S | must |
| [SPK-006](SPK-phase0.md#spk-006-decide-the-first-market) | Decide the first market | decision | S | must |
| [SPK-007](SPK-phase0.md#spk-007-decide-the-projects-names-and-licence) | Decide the project's names and licence | decision | S | must |
| [SPK-010](SPK-phase0.md#spk-010-decide-who-invites-and-authenticates-workflow-participants) | Decide who invites and authenticates workflow participants | decision | S | must |
| [SPK-014](SPK-phase0.md#spk-014-s1-prosemirror-inside-an-open-shadow-root) | S1: ProseMirror inside an open shadow root | spike | M | must |
| [SPK-015](SPK-phase0.md#spk-015-s2-strict-content-security-policy-and-trusted-types-including-webassembly) | S2: strict content security policy and Trusted Types, including WebAssembly | spike | M | must |
| [SPK-016](SPK-phase0.md#spk-016-s3-correctness-of-the-authority) | S3: correctness of the authority | spike | L | must |
| [SPK-017](SPK-phase0.md#spk-017-s4-safe-latex-compiles-that-report-where-lines-and-pages-broke) | S4: safe LaTeX compiles that report where lines and pages broke | spike | L | must |
| [SPK-019](SPK-phase0.md#spk-019-s6-can-someone-else-implement-the-protocol) | S6: can someone else implement the protocol? | spike | M | must |
| [SPK-024](SPK-phase0.md#spk-024-legal-note) | Legal note | spike | M | must |
| [SPK-026](SPK-phase0.md#spk-026-borrow-list-with-licences-checked) | Borrow list with licences checked | spike | M | must |
| [SPK-028](SPK-phase0.md#spk-028-s11-prove-lossless-docx-round-trip-on-real-word-files) | S11: prove lossless DOCX round-trip on real Word files | spike | M | must |
| [SPK-029](SPK-phase0.md#spk-029-s12-hide-regions-and-field-values-from-some-readers-by-projection) | S12: hide regions and field values from some readers by projection | spike | M | must |
| [CDM-001](CDM-document-model.md#cdm-001-decide-the-footnote-content-model) | Decide the footnote content model | decision | S | must |
| [CDM-002](CDM-document-model.md#cdm-002-decide-the-attribute-grammars-defaults-and-reference-forms-that-03-leaves-open) | Decide the attribute grammars, defaults and reference forms that 03 leaves open | decision | M | must |
| [CDM-003](CDM-document-model.md#cdm-003-decide-the-canonical-form-gaps) | Decide the canonical-form gaps | decision | S | must |
| [CDM-005](CDM-document-model.md#cdm-005-spike-settle-the-numbering-and-spacing-semantics-and-write-the-fixtures) | Spike: settle the numbering and spacing semantics and write the fixtures | spike | M | must |
| [CDM-006](CDM-document-model.md#cdm-006-define-the-cdm-once-and-generate-everything-else-from-it) | Define the CDM once and generate everything else from it | enabler | M | must |
| [CDM-007](CDM-document-model.md#cdm-007-publish-the-cdm-json-schema) | Publish the CDM JSON Schema | story | M | must |
| [CDM-008](CDM-document-model.md#cdm-008-generate-the-prosemirror-schema-from-the-definition-and-publish-it) | Generate the ProseMirror schema from the definition and publish it | enabler | M | must |
| [CDM-051](CDM-document-model.md#cdm-051-define-the-preservation-feature-preserved-atoms-the-preserved-mark-and-the-preserved-attribute) | Define the preservation feature: preserved atoms, the preserved mark and the preserved attribute | enabler | M | must |
| [PRO-001](PRO-protocol.md#pro-001-publish-an-asyncapi-definition-of-the-real-time-plane) | Publish an AsyncAPI definition of the real-time plane | enabler | M | must |
| [PRO-002](PRO-protocol.md#pro-002-publish-an-openapi-definition-of-the-control-plane) | Publish an OpenAPI definition of the control plane | enabler | M | must |
| [PRO-003](PRO-protocol.md#pro-003-publish-json-schemas-for-webhook-bodies-and-the-cdm) | Publish JSON Schemas for webhook bodies and the CDM | enabler | S | must |
| [PRO-091](PRO-protocol.md#pro-091-publish-complete-typings-for-the-core-ports) | Publish complete typings for the core ports | enabler | M | must |
| [PRO-092](PRO-protocol.md#pro-092-publish-complete-typings-for-the-optional-ports) | Publish complete typings for the optional ports | enabler | M | must |
| [FRW-083](FRW-fields-rules-workflow.md#frw-083-decide-whether-form-mode-without-a-workflow-is-the-first-slice) | Decide whether form mode without a workflow is the first slice | decision | S | must |
| [SPK-005](SPK-phase0.md#spk-005-decide-whether-regions-or-field-values-may-be-hidden-from-some-readers) | Decide whether regions or field values may be hidden from some readers | decision | S | should |
| [SPK-008](SPK-phase0.md#spk-008-decide-hosted-service-self-hosted-distribution-or-both-at-first-release) | Decide hosted service, self-hosted distribution, or both at first release | decision | S | should |
| [SPK-011](SPK-phase0.md#spk-011-decide-the-first-jurisdictions-and-the-sealing-party) | Decide the first jurisdictions and the sealing party | decision | S | should |
| [SPK-012](SPK-phase0.md#spk-012-decide-fixed-width-or-reflowing-fields) | Decide fixed-width or reflowing fields | decision | S | should |
| [SPK-018](SPK-phase0.md#spk-018-s5-how-to-measure-text-for-the-page-view) | S5: how to measure text for the page view | spike | M | should |
| [SPK-020](SPK-phase0.md#spk-020-s7-adopt-fork-or-build-the-layout-core) | S7: adopt, fork or build the layout core | spike | M | should |
| [SPK-021](SPK-phase0.md#spk-021-s8-seal-a-tagged-pdf-with-a-managed-key-and-a-time-stamp) | S8: seal a tagged PDF with a managed key and a time-stamp | spike | S | should |
| [SPK-025](SPK-phase0.md#spk-025-unit-cost-sheet) | Unit-cost sheet | spike | S | should |
| [SPK-027](SPK-phase0.md#spk-027-second-review-of-the-specification) | Second review of the specification | spike | M | should |
| [CDM-004](CDM-document-model.md#cdm-004-decide-whether-citations-and-a-bibliography-enter-cdm-1) | Decide whether citations and a bibliography enter CDM 1 | decision | S | should |
| [PRM-061](PRM-permissions.md#prm-061-decide-whether-everyone-may-be-granted-a-role-on-a-restricted-region) | Decide whether `everyone` may be granted a role on a restricted region | decision | S | should |
| [SPK-009](SPK-phase0.md#spk-009-decide-the-language-of-the-production-backend) | Decide the language of the production backend | decision | S | could |
| [SPK-023](SPK-phase0.md#spk-023-s10-text-kernel-in-typescript-or-in-rust-compiled-to-webassembly) | S10: text kernel in TypeScript or in Rust compiled to WebAssembly | spike | M | could |

## Phase 1a: minimum demo (164)

| Story | Title | Type | Size | Priority |
|---|---|---|---|---|
| [FND-003](FND-foundations.md#fnd-003-shared-conventions-for-identifiers-time-lengths-numbers-colours-and-errors) | Shared conventions for identifiers, time, lengths, numbers, colours and errors | enabler | S | must |
| [FND-004](FND-foundations.md#fnd-004-architecture-boundary-checks) | Architecture boundary checks | enabler | S | must |
| [FND-005](FND-foundations.md#fnd-005-canonical-json-hashing-and-compression-primitives) | Canonical JSON, hashing and compression primitives | enabler | S | must |
| [FND-008](FND-foundations.md#fnd-008-bundle-size-budget-gate) | Bundle-size budget gate | enabler | S | must |
| [FND-010](FND-foundations.md#fnd-010-integration-test-environment) | Integration-test environment | enabler | S | must |
| [FND-011](FND-foundations.md#fnd-011-licence-gate) | Licence gate | enabler | S | must |
| [CDM-009](CDM-document-model.md#cdm-009-refuse-a-document-the-reader-cannot-fully-understand) | Refuse a document the reader cannot fully understand | story | S | must |
| [CDM-012](CDM-document-model.md#cdm-012-keep-node-identity-stable-through-split-join-copy-and-paste) | Keep node identity stable through split, join, copy and paste | story | M | must |
| [CDM-013](CDM-document-model.md#cdm-013-build-modelvalidate-and-the-invariant-engine) | Build `model.validate()` and the invariant engine | enabler | L | must |
| [CDM-016](CDM-document-model.md#cdm-016-give-a-paragraph-a-named-style-that-inherits-from-another) | Give a paragraph a named style that inherits from another | story | M | must |
| [CDM-024](CDM-document-model.md#cdm-024-make-regions-real-containers-with-a-stable-identity) | Make regions real containers with a stable identity | story | M | must |
| [SYN-001](SYN-sync-engine.md#syn-001-build-the-authority-as-a-package-of-pure-functions) | Build the authority as a package of pure functions | enabler | M | must |
| [SYN-002](SYN-sync-engine.md#syn-002-pin-the-step-semantics-with-an-engine-definition-file-and-golden-fixtures) | Pin the step semantics with an engine definition file and golden fixtures | enabler | M | must |
| [SYN-003](SYN-sync-engine.md#syn-003-validate-step-commits-shape-limits-and-the-step-allow-list) | Validate step commits: shape, limits and the step allow-list | enabler | M | must |
| [SYN-004](SYN-sync-engine.md#syn-004-record-permission-and-workflow-changes-as-control-commits) | Record permission and workflow changes as control commits | enabler | M | must |
| [SYN-006](SYN-sync-engine.md#syn-006-process-submissions-one-at-a-time-against-durable-and-tentative-state) | Process submissions one at a time against durable and tentative state | enabler | L | must |
| [SYN-007](SYN-sync-engine.md#syn-007-authorise-a-submission-and-allow-one-commit-in-flight-per-channel) | Authorise a submission and allow one commit in flight per channel | enabler | S | must |
| [SYN-008](SYN-sync-engine.md#syn-008-deduplicate-resubmitted-commits) | Deduplicate resubmitted commits | enabler | M | must |
| [SYN-009](SYN-sync-engine.md#syn-009-reject-commits-with-an-impossible-or-too-distant-base) | Reject commits with an impossible or too distant base | enabler | S | must |
| [SYN-010](SYN-sync-engine.md#syn-010-rebase-a-commit-over-everything-accepted-since-its-base) | Rebase a commit over everything accepted since its base | enabler | L | must |
| [SYN-011](SYN-sync-engine.md#syn-011-apply-the-steps-and-check-the-document-invariants) | Apply the steps and check the document invariants | enabler | M | must |
| [SYN-013](SYN-sync-engine.md#syn-013-call-the-outcome-check-and-write-only-under-the-grants-revision-it-used) | Call the outcome check and write only under the grants revision it used | enabler | M | must |
| [SYN-014](SYN-sync-engine.md#syn-014-stamp-each-commit-with-server-side-attribution) | Stamp each commit with server-side attribution | enabler | S | must |
| [SYN-015](SYN-sync-engine.md#syn-015-acknowledge-and-broadcast-in-sequence-order-only-after-storage) | Acknowledge and broadcast in sequence order, only after storage | enabler | M | must |
| [SYN-016](SYN-sync-engine.md#syn-016-recover-when-a-write-fails-or-its-outcome-is-unknown) | Recover when a write fails or its outcome is unknown | enabler | L | must |
| [SYN-017](SYN-sync-engine.md#syn-017-keep-a-confirmed-document-and-rebuild-from-it) | Keep a confirmed document and rebuild from it | story | L | must |
| [SYN-018](SYN-sync-engine.md#syn-018-send-local-edits-as-one-in-flight-commit) | Send local edits as one in-flight commit | story | M | must |
| [SYN-019](SYN-sync-engine.md#syn-019-apply-remote-commits-and-detect-gaps) | Apply remote commits and detect gaps | story | M | must |
| [SYN-020](SYN-sync-engine.md#syn-020-act-on-a-rejection-by-its-code-and-action) | Act on a rejection by its code and action | story | M | must |
| [SYN-035](SYN-sync-engine.md#syn-035-relay-presence-with-server-identity-limits-and-no-storage) | Relay presence with server identity, limits and no storage | story | M | must |
| [SYN-047](SYN-sync-engine.md#syn-047-run-the-convergence-property-suite-against-the-real-service) | Run the convergence property suite against the real service | enabler | L | must |
| [PRM-001](PRM-permissions.md#prm-001-define-capabilities-roles-scopes-and-principals-once) | Define capabilities, roles, scopes and principals once | enabler | M | must |
| [PRM-002](PRM-permissions.md#prm-002-keep-permission-data-in-the-document-service-behind-a-grantstore) | Keep permission data in the document service behind a GrantStore | enabler | M | must |
| [PRM-004](PRM-permissions.md#prm-004-compute-effective-capabilities-per-scope) | Compute effective capabilities per scope | enabler | M | must |
| [PRM-006](PRM-permissions.md#prm-006-keep-every-connections-access-current) | Keep every connection's access current | story | M | must |
| [PRM-008](PRM-permissions.md#prm-008-partition-a-document-into-permission-scopes) | Partition a document into permission scopes | enabler | L | must |
| [PRM-009](PRM-permissions.md#prm-009-accept-a-commit-only-if-every-changed-scope-is-writable) | Accept a commit only if every changed scope is writable | story | L | must |
| [PRM-010](PRM-permissions.md#prm-010-apply-the-base-rules-p1-p5-and-p6) | Apply the base rules P1, P5 and P6 | story | M | must |
| [PRM-017](PRM-permissions.md#prm-017-build-the-permission-oracle-for-property-tests) | Build the permission oracle for property tests | enabler | L | must |
| [PRM-018](PRM-permissions.md#prm-018-set-and-read-region-grants-through-the-control-api) | Set and read region grants through the control API | story | M | must |
| [PRM-019](PRM-permissions.md#prm-019-make-a-grant-change-reach-connected-people-at-once) | Make a grant change reach connected people at once | story | L | must |
| [PRM-020](PRM-permissions.md#prm-020-reject-a-commit-made-under-old-permissions) | Reject a commit made under old permissions | story | M | must |
| [PRM-024](PRM-permissions.md#prm-024-explain-a-rejected-change) | Explain a rejected change | story | S | must |
| [PRO-004](PRO-protocol.md#pro-004-share-dep-types-codecs-and-client-state-machines-in-the-protocol-package) | Share DEP types, codecs and client state machines in the `protocol` package | enabler | M | must |
| [PRO-005](PRO-protocol.md#pro-005-ignore-what-is-not-known) | Ignore what is not known | enabler | S | must |
| [PRO-006](PRO-protocol.md#pro-006-negotiate-the-protocol-version-and-features) | Negotiate the protocol version and features | story | M | must |
| [PRO-008](PRO-protocol.md#pro-008-publish-a-discovery-document) | Publish a discovery document | story | S | must |
| [PRO-009](PRO-protocol.md#pro-009-accept-user-tokens-with-the-defined-claims) | Accept user tokens with the defined claims | story | M | must |
| [PRO-010](PRO-protocol.md#pro-010-verify-tokens-against-the-tenants-keys) | Verify tokens against the tenant's keys | enabler | M | must |
| [PRO-011](PRO-protocol.md#pro-011-mint-a-user-token-through-the-service) | Mint a user token through the service | story | M | must |
| [PRO-012](PRO-protocol.md#pro-012-call-the-control-plane-with-an-api-key-service-credential) | Call the control plane with an API-key service credential | story | S | must |
| [PRO-017](PRO-protocol.md#pro-017-exchange-framed-json-messages-on-one-multiplexed-socket) | Exchange framed JSON messages on one multiplexed socket | enabler | M | must |
| [PRO-021](PRO-protocol.md#pro-021-open-a-session-with-hello-and-welcome) | Open a session with hello and welcome | story | M | must |
| [PRO-022](PRO-protocol.md#pro-022-advertise-every-limit-a-client-must-respect) | Advertise every limit a client must respect | enabler | M | must |
| [PRO-023](PRO-protocol.md#pro-023-open-a-document-channel) | Open a document channel | story | M | must |
| [PRO-027](PRO-protocol.md#pro-027-submit-a-commit-and-receive-the-acknowledgement) | Submit a commit and receive the acknowledgement | story | M | must |
| [PRO-028](PRO-protocol.md#pro-028-receive-a-typed-rejection-with-the-next-action) | Receive a typed rejection with the next action | story | M | must |
| [PRO-029](PRO-protocol.md#pro-029-receive-other-peoples-commits-in-order) | Receive other people's commits in order | story | M | must |
| [PRO-031](PRO-protocol.md#pro-031-share-selections-between-sessions) | Share selections between sessions | story | M | must |
| [PRO-032](PRO-protocol.md#pro-032-receive-effective-access-when-a-channel-opens) | Receive effective access when a channel opens | story | M | must |
| [PRO-033](PRO-protocol.md#pro-033-receive-live-permission-changes) | Receive live permission changes | story | M | must |
| [PRO-037](PRO-protocol.md#pro-037-close-the-connection-with-a-defined-code-and-a-matching-error) | Close the connection with a defined code and a matching error | enabler | M | must |
| [PRO-038](PRO-protocol.md#pro-038-publish-one-error-registry-for-every-surface) | Publish one error registry for every surface | enabler | M | must |
| [PRO-040](PRO-protocol.md#pro-040-use-json-problem-details-and-cursor-lists-on-every-rest-route) | Use JSON, problem details and cursor lists on every REST route | enabler | S | must |
| [PRO-041](PRO-protocol.md#pro-041-allow-browsers-to-call-the-control-plane) | Allow browsers to call the control plane | enabler | S | must |
| [PRO-042](PRO-protocol.md#pro-042-update-safely-with-etag-and-if-match) | Update safely with ETag and If-Match | enabler | S | must |
| [PRO-045](PRO-protocol.md#pro-045-resolve-resources-addressed-by-a-bare-identifier-to-their-document) | Resolve resources addressed by a bare identifier to their document | enabler | S | must |
| [PRO-046](PRO-protocol.md#pro-046-create-and-list-documents-with-a-service-credential) | Create and list documents with a service credential | story | M | must |
| [PRO-049](PRO-protocol.md#pro-049-read-document-content-at-the-head-or-at-a-pinned-sequence-number) | Read document content at the head or at a pinned sequence number | story | M | must |
| [PRO-051](PRO-protocol.md#pro-051-list-the-regions-of-a-document) | List the regions of a document | story | S | must |
| [PRO-052](PRO-protocol.md#pro-052-read-and-change-region-grants) | Read and change region grants | story | M | must |
| [PRO-063](PRO-protocol.md#pro-063-request-an-export) | Request an export | story | M | must |
| [PRO-064](PRO-protocol.md#pro-064-follow-and-cancel-an-export-job) | Follow and cancel an export job | story | M | must |
| [PRO-074](PRO-protocol.md#pro-074-load-a-document-from-attributes) | Load a document from attributes | story | M | must |
| [PRO-075](PRO-protocol.md#pro-075-supply-tokens-with-gettoken) | Supply tokens with `getToken` | story | M | must |
| [PRO-076](PRO-protocol.md#pro-076-control-the-element-with-load-focus-and-destroy-and-read-the-embedding-version) | Control the element with `load`, `focus` and `destroy`, and read the embedding version | story | S | must |
| [PRO-080](PRO-protocol.md#pro-080-look-up-people-through-the-hosts-directory) | Look up people through the host's directory | story | M | must |
| [PRO-087](PRO-protocol.md#pro-087-raise-composed-events-that-carry-identifiers-and-counts-only) | Raise composed events that carry identifiers and counts only | story | M | must |
| [PRO-088](PRO-protocol.md#pro-088-see-permission-changes-in-the-host-page) | See permission changes in the host page | story | S | must |
| [PRO-093](PRO-protocol.md#pro-093-backend-dep-connect-and-keep-a-session) | `backend-dep`: connect and keep a session | enabler | M | must |
| [PRO-094](PRO-protocol.md#pro-094-backend-dep-open-a-sync-channel-and-submit-commits) | `backend-dep`: open a sync channel and submit commits | enabler | L | must |
| [BE-001](BE-backend.md#be-001-run-the-stage-1-document-service-as-one-process) | Run the stage 1 document service as one process | enabler | M | must |
| [BE-002](BE-backend.md#be-002-define-the-adapter-interfaces-and-their-contract-tests) | Define the adapter interfaces and their contract tests | enabler | M | must |
| [BE-003](BE-backend.md#be-003-store-files-in-an-s3-compatible-object-store) | Store files in an S3-compatible object store | enabler | M | must |
| [BE-005](BE-backend.md#be-005-start-the-whole-stack-from-a-compose-file) | Start the whole stack from a compose file | story | M | must |
| [BE-008](BE-backend.md#be-008-decide-the-hash-partition-count-of-the-log-tables) | Decide the hash-partition count of the log tables | decision | S | must |
| [BE-009](BE-backend.md#be-009-create-the-commit-log-tables) | Create the commit log tables | enabler | L | must |
| [BE-010](BE-backend.md#be-010-create-the-grant-tables) | Create the grant tables | enabler | S | must |
| [BE-011](BE-backend.md#be-011-isolate-tenants-with-row-level-security) | Isolate tenants with row-level security | enabler | L | must |
| [BE-012](BE-backend.md#be-012-register-tenants-token-keys-and-allowed-origins) | Register tenants, token keys and allowed origins | enabler | M | must |
| [BE-013](BE-backend.md#be-013-map-host-user-identifiers-to-per-tenant-surrogates) | Map host user identifiers to per-tenant surrogates | enabler | M | must |
| [BE-017](BE-backend.md#be-017-fence-log-writes-with-the-ownership-epoch) | Fence log writes with the ownership epoch | enabler | L | must |
| [BE-019](BE-backend.md#be-019-open-a-room-from-a-checkpoint-and-the-log-tail) | Open a room from a checkpoint and the log tail | enabler | L | must |
| [BE-024](BE-backend.md#be-024-persist-commits-in-group-commit-transactions) | Persist commits in group-commit transactions | enabler | L | must |
| [BE-025](BE-backend.md#be-025-handle-failed-unknown-and-conflicting-writes) | Handle failed, unknown and conflicting writes | enabler | L | must |
| [BE-026](BE-backend.md#be-026-refuse-commits-checked-against-stale-grants) | Refuse commits checked against stale grants | enabler | M | must |
| [BE-029](BE-backend.md#be-029-accept-and-authenticate-websocket-connections) | Accept and authenticate WebSocket connections | enabler | L | must |
| [BE-032](BE-backend.md#be-032-run-every-control-plane-request-through-one-pipeline) | Run every control-plane request through one pipeline | enabler | M | must |
| [BE-033](BE-backend.md#be-033-authenticate-host-backends-and-mint-tokens) | Authenticate host backends and mint tokens | story | M | must |
| [BE-035](BE-backend.md#be-035-create-read-update-and-delete-documents) | Create, read, update and delete documents | story | L | must |
| [BE-036](BE-backend.md#be-036-read-content-without-opening-a-room) | Read content without opening a room | story | L | must |
| [BE-049](BE-backend.md#be-049-run-background-jobs-from-a-postgresql-queue) | Run background jobs from a PostgreSQL queue | enabler | M | must |
| [BE-088](BE-backend.md#be-088-write-structured-logs-without-content-or-tokens) | Write structured logs without content or tokens | enabler | S | must |
| [SEC-001](SEC-security.md#sec-001-keep-a-threat-register-that-ties-every-threat-to-a-test) | Keep a threat register that ties every threat to a test | enabler | M | must |
| [SEC-002](SEC-security.md#sec-002-build-an-adversarial-protocol-client) | Build an adversarial protocol client | enabler | M | must |
| [SEC-003](SEC-security.md#sec-003-review-the-threat-model-at-the-end-of-every-phase) | Review the threat model at the end of every phase | enabler | M | must |
| [SEC-012](SEC-security.md#sec-012-prove-cross-site-requests-are-refused) | Prove cross-site requests are refused | enabler | M | must |
| [SEC-013](SEC-security.md#sec-013-prove-token-verification-resists-confusion) | Prove token verification resists confusion | enabler | M | must |
| [SEC-017](SEC-security.md#sec-017-prove-malformed-and-oversized-input-is-refused) | Prove malformed and oversized input is refused | enabler | M | must |
| [SEC-019](SEC-security.md#sec-019-prove-identity-cannot-be-spoofed) | Prove identity cannot be spoofed | enabler | M | must |
| [SEC-021](SEC-security.md#sec-021-cover-the-known-bypass-classes-in-the-permission-property-tests) | Cover the known bypass classes in the permission property tests | enabler | L | must |
| [SEC-025](SEC-security.md#sec-025-prove-rebase-tricks-cannot-bypass-checks) | Prove rebase tricks cannot bypass checks | enabler | M | must |
| [SEC-026](SEC-security.md#sec-026-prove-permission-changes-cannot-be-raced) | Prove permission changes cannot be raced | enabler | M | must |
| [SEC-027](SEC-security.md#sec-027-prove-corrupting-commits-are-refused) | Prove corrupting commits are refused | enabler | M | must |
| [SEC-031](SEC-security.md#sec-031-prove-two-writers-cannot-both-append) | Prove two writers cannot both append | enabler | M | must |
| [SEC-045](SEC-security.md#sec-045-prove-one-tenant-cannot-reach-anothers-data) | Prove one tenant cannot reach another's data | enabler | L | must |
| [SEC-047](SEC-security.md#sec-047-prove-logs-and-metrics-hold-no-content-or-tokens) | Prove logs and metrics hold no content or tokens | enabler | M | must |
| [SEC-050](SEC-security.md#sec-050-lock-dependencies-and-review-changes) | Lock dependencies and review changes | enabler | M | must |
| [SEC-059](SEC-security.md#sec-059-run-fuzzers-in-ci-with-a-shared-corpus) | Run fuzzers in CI with a shared corpus | enabler | M | must |
| [FE-001](FE-frontend.md#fe-001-register-the-element-safely) | Register the element safely | story | M | must |
| [FE-002](FE-frontend.md#fe-002-build-one-es-module-with-lazy-chunks) | Build one ES module with lazy chunks | enabler | M | must |
| [FE-003](FE-frontend.md#fe-003-start-loading-when-the-host-has-set-everything-in-any-order) | Start loading when the host has set everything, in any order | story | M | must |
| [FE-004](FE-frontend.md#fe-004-mount-the-application-once-and-resume-it-on-later-connects) | Mount the application once and resume it on later connects | story | M | must |
| [FE-007](FE-frontend.md#fe-007-expose-the-save-state) | Expose the save state | story | S | must |
| [FE-013](FE-frontend.md#fe-013-create-the-shadow-root-and-manage-focus-explicitly) | Create the shadow root and manage focus explicitly | story | S | must |
| [FE-014](FE-frontend.md#fe-014-share-one-constructable-stylesheet-between-instances) | Share one constructable stylesheet between instances | story | M | must |
| [FE-016](FE-frontend.md#fe-016-build-the-interface-without-html-string-templates) | Build the interface without HTML-string templates | story | M | must |
| [FE-018](FE-frontend.md#fe-018-isolate-styles-and-expose---de--properties-and-parts) | Isolate styles and expose `--de-` properties and parts | story | M | must |
| [FE-021](FE-frontend.md#fe-021-handle-shortcuts-only-for-events-from-inside-the-editor) | Handle shortcuts only for events from inside the editor | story | S | must |
| [FE-022](FE-frontend.md#fe-022-dispatch-every-outgoing-event-as-composed) | Dispatch every outgoing event as composed | story | S | must |
| [FE-023](FE-frontend.md#fe-023-keep-document-state-outside-svelte-reactivity) | Keep document state outside Svelte reactivity | enabler | M | must |
| [FE-024](FE-frontend.md#fe-024-limit-interface-updates-to-one-per-animation-frame) | Limit interface updates to one per animation frame | enabler | S | must |
| [FE-025](FE-frontend.md#fe-025-attach-order-sensitive-handlers-with-on) | Attach order-sensitive handlers with `on` | enabler | S | must |
| [FE-026](FE-frontend.md#fe-026-change-a-document-only-through-the-document-api) | Change a document only through the document API | story | L | must |
| [FE-030](FE-frontend.md#fe-030-load-the-editing-schema-from-the-cdm) | Load the editing schema from the CDM | enabler | M | must |
| [FE-031](FE-frontend.md#fe-031-fill-in-missing-identifiers-in-the-same-transaction) | Fill in missing identifiers in the same transaction | story | M | must |
| [FE-032](FE-frontend.md#fe-032-keep-body-commands-inside-the-body) | Keep body commands inside the body | story | M | must |
| [FE-033](FE-frontend.md#fe-033-host-the-sync-client-inside-the-editing-core) | Host the sync client inside the editing core | enabler | L | must |
| [FE-036](FE-frontend.md#fe-036-refuse-local-edits-in-scopes-the-user-cannot-change) | Refuse local edits in scopes the user cannot change | story | L | must |
| [FE-038](FE-frontend.md#fe-038-clamp-selections-at-region-boundaries) | Clamp selections at region boundaries | story | M | must |
| [FE-039](FE-frontend.md#fe-039-keep-a-body-paragraph-after-every-region) | Keep a body paragraph after every region | story | S | must |
| [FE-071](FE-frontend.md#fe-071-show-a-typeset-pdf-in-an-isolated-viewer) | Show a typeset PDF in an isolated viewer | story | L | must |
| [FE-121](FE-frontend.md#fe-121-run-the-editing-core-in-nodejs-without-a-browser) | Run the editing core in Node.js without a browser | enabler | M | must |
| [FE-122](FE-frontend.md#fe-122-drive-the-element-with-playwright-in-every-supported-browser) | Drive the element with Playwright in every supported browser | enabler | M | must |
| [FE-127](FE-frontend.md#fe-127-apply-paragraph-styles) | Apply paragraph styles | story | M | must |
| [UX-001](UX-experience.md#ux-001-maintain-the-parity-profile-as-a-published-artifact) | Maintain the parity profile as a published artifact | enabler | M | must |
| [UX-003](UX-experience.md#ux-003-command-registry-that-drives-every-command-surface) | Command registry that drives every command surface | enabler | L | must |
| [UX-004](UX-experience.md#ux-004-commands-respect-the-users-current-permissions) | Commands respect the user's current permissions | story | M | must |
| [UX-006](UX-experience.md#ux-006-compact-toolbar) | Compact toolbar | story | M | must |
| [UX-014](UX-experience.md#ux-014-header-frame-title-slot-and-host-replaceable-header) | Header frame, title slot and host-replaceable header | story | M | must |
| [UX-016](UX-experience.md#ux-016-save-state-and-connection-state) | Save state and connection state | story | M | must |
| [UX-025](UX-experience.md#ux-025-resolve-people-through-the-hosts-directory) | Resolve people through the host's directory | enabler | S | must |
| [UX-026](UX-experience.md#ux-026-presence-avatars-in-the-header) | Presence avatars in the header | story | M | must |
| [UX-064](UX-experience.md#ux-064-externalised-strings-locale-attribute-and-logical-layout) | Externalised strings, locale attribute and logical layout | enabler | M | must |
| [UX-091](UX-experience.md#ux-091-reference-host-compose-stack-and-demo-harness) | Reference host: compose stack and demo harness | enabler | L | must |
| [UX-092](UX-experience.md#ux-092-reference-host-seeded-users-and-token-minting) | Reference host: seeded users and token minting | story | M | must |
| [UX-093](UX-experience.md#ux-093-reference-host-page-glue) | Reference host: page glue | story | M | must |
| [UX-094](UX-experience.md#ux-094-reference-host-document-list-and-the-hosts-catalogue) | Reference host: document list and the host's catalogue | story | M | must |
| [HIS-001](HIS-history.md#his-001-record-every-accepted-commit-in-full) | Record every accepted commit in full | enabler | L | must |
| [HIS-002](HIS-history.md#his-002-chain-every-commit-by-hash) | Chain every commit by hash | enabler | M | must |
| [HIS-003](HIS-history.md#his-003-keep-personal-data-out-of-commit-records) | Keep personal data out of commit records | enabler | M | must |
| [EXP-001](EXP-export.md#exp-001-export-a-document-of-regions-and-three-paragraph-styles-to-pdf) | Export a document of regions and three paragraph styles to PDF | story | L | must |
| [EXP-042](EXP-export.md#exp-042-emit-text-and-generated-identifiers-safely) | Emit text and generated identifiers safely | enabler | M | must |
| [FND-014](FND-foundations.md#fnd-014-requirements-traceability) | Requirements traceability | enabler | S | could |

## Phase 1b: first usable release (382)

| Story | Title | Type | Size | Priority |
|---|---|---|---|---|
| [FND-009](FND-foundations.md#fnd-009-service-latency-load-and-fault-injection-harness) | Service latency, load and fault-injection harness | enabler | M | must |
| [FND-012](FND-foundations.md#fnd-012-release-pipeline) | Release pipeline | enabler | M | must |
| [CDM-010](CDM-document-model.md#cdm-010-compute-the-canonical-form-and-the-document-hash) | Compute the canonical form and the document hash | enabler | M | must |
| [CDM-011](CDM-document-model.md#cdm-011-publish-the-canonical-form-hash-fixtures) | Publish the canonical-form hash fixtures | enabler | S | must |
| [CDM-014](CDM-document-model.md#cdm-014-provide-negative-fixtures-for-every-invariant-and-every-step-type) | Provide negative fixtures for every invariant and every step type | enabler | M | must |
| [CDM-015](CDM-document-model.md#cdm-015-fuzz-the-readers-and-the-validator) | Fuzz the readers and the validator | enabler | M | must |
| [CDM-017](CDM-document-model.md#cdm-017-define-character-and-table-styles-one-attribute-per-property) | Define character and table styles, one attribute per property | story | M | must |
| [CDM-018](CDM-document-model.md#cdm-018-hold-document-wide-defaults-in-one-settings-node) | Hold document-wide defaults in one settings node | story | S | must |
| [CDM-019](CDM-document-model.md#cdm-019-define-multi-level-numbering) | Define multi-level numbering | story | M | must |
| [CDM-020](CDM-document-model.md#cdm-020-define-page-setups-and-page-sections) | Define page setups and page sections | story | M | must |
| [CDM-021](CDM-document-model.md#cdm-021-define-headers-and-footers-as-stories) | Define headers and footers as stories | story | M | must |
| [CDM-022](CDM-document-model.md#cdm-022-reserve-the-nodes-for-fields-and-extensions) | Reserve the nodes for fields and extensions | enabler | S | must |
| [CDM-025](CDM-document-model.md#cdm-025-hold-run-and-paragraph-formatting-as-integer-valued-properties) | Hold run and paragraph formatting as integer-valued properties | story | M | must |
| [CDM-026](CDM-document-model.md#cdm-026-put-list-items-in-a-list-instance) | Put list items in a list instance | story | S | must |
| [CDM-027](CDM-document-model.md#cdm-027-build-tables-with-rows-cells-and-spans) | Build tables with rows, cells and spans | story | L | must |
| [CDM-028](CDM-document-model.md#cdm-028-describe-table-width-grid-borders-shading-and-row-heights) | Describe table width, grid, borders, shading and row heights | story | M | must |
| [CDM-029](CDM-document-model.md#cdm-029-add-images-and-figures-by-asset-reference) | Add images and figures by asset reference | story | M | must |
| [CDM-030](CDM-document-model.md#cdm-030-store-equations-as-latex-behind-a-gate) | Store equations as LaTeX behind a gate | story | M | must |
| [CDM-031](CDM-document-model.md#cdm-031-add-a-table-of-contents-that-generates-its-own-entries) | Add a table of contents that generates its own entries | story | S | must |
| [CDM-032](CDM-document-model.md#cdm-032-carry-custom-content-with-a-mandatory-fallback) | Carry custom content with a mandatory fallback | story | M | must |
| [CDM-033](CDM-document-model.md#cdm-033-add-line-page-and-column-breaks-and-tabs) | Add line, page and column breaks and tabs | story | S | must |
| [CDM-034](CDM-document-model.md#cdm-034-add-footnotes-of-one-paragraph) | Add footnotes of one paragraph | story | M | must |
| [CDM-035](CDM-document-model.md#cdm-035-insert-page-date-and-title-fields) | Insert page, date and title fields | story | M | must |
| [CDM-036](CDM-document-model.md#cdm-036-insert-cross-references-caption-sequences-and-bookmarks) | Insert cross-references, caption sequences and bookmarks | story | M | must |
| [CDM-037](CDM-document-model.md#cdm-037-format-characters-with-marks) | Format characters with marks | story | M | must |
| [CDM-038](CDM-document-model.md#cdm-038-restrict-link-targets-to-safe-schemes) | Restrict link targets to safe schemes | story | S | must |
| [CDM-039](CDM-document-model.md#cdm-039-define-suggestion-marks-that-coexist) | Define suggestion marks that coexist | story | M | must |
| [CDM-041](CDM-document-model.md#cdm-041-resolve-formatting-through-the-cascade) | Resolve formatting through the cascade | story | L | must |
| [CDM-042](CDM-document-model.md#cdm-042-compute-list-heading-caption-and-cross-reference-labels-once) | Compute list, heading, caption and cross-reference labels once | story | L | must |
| [CDM-043](CDM-document-model.md#cdm-043-compute-paragraph-gaps-and-line-heights-once) | Compute paragraph gaps and line heights once | story | M | must |
| [CDM-044](CDM-document-model.md#cdm-044-resolve-tab-stops-the-same-way-everywhere) | Resolve tab stops the same way everywhere | story | S | must |
| [CDM-047](CDM-document-model.md#cdm-047-add-a-feature-to-a-document-only-when-every-client-has-it) | Add a feature to a document only when every client has it | story | M | must |
| [CDM-048](CDM-document-model.md#cdm-048-extend-nodes-and-marks-additively-through-ext) | Extend nodes and marks additively through `ext` | story | M | must |
| [CDM-052](CDM-document-model.md#cdm-052-define-sources-citations-and-bibliographies-in-the-model) | Define sources, citations and bibliographies in the model | enabler | M | must |
| [CDM-053](CDM-document-model.md#cdm-053-add-the-confidential-policy-the-placeholder-and-the-redaction-marker) | Add the confidential policy, the placeholder and the redaction marker | enabler | M | must |
| [SYN-005](SYN-sync-engine.md#syn-005-store-snapshot-commits-and-send-syncreset) | Store snapshot commits and send `sync.reset` | enabler | M | must |
| [SYN-012](SYN-sync-engine.md#syn-012-check-the-field-invariants-i13-to-i15) | Check the field invariants I13 to I15 | enabler | S | must |
| [SYN-021](SYN-sync-engine.md#syn-021-handle-rejected-fills) | Handle rejected fills | story | S | must |
| [SYN-022](SYN-sync-engine.md#syn-022-rebase-the-undo-history-over-remote-commits) | Rebase the undo history over remote commits | story | M | must |
| [SYN-023](SYN-sync-engine.md#syn-023-reload-on-a-snapshot-reset) | Reload on a snapshot reset | story | M | must |
| [SYN-026](SYN-sync-engine.md#syn-026-decide-how-a-resuming-channel-catches-up) | Decide how a resuming channel catches up | enabler | L | must |
| [SYN-027](SYN-sync-engine.md#syn-027-subscribe-and-stream-without-a-missed-or-repeated-commit) | Subscribe and stream without a missed or repeated commit | enabler | M | must |
| [SYN-028](SYN-sync-engine.md#syn-028-reconnect-and-resubmit-in-flight-work) | Reconnect and resubmit in-flight work | story | L | must |
| [SYN-029](SYN-sync-engine.md#syn-029-identify-the-log-by-an-incarnation) | Identify the log by an incarnation | enabler | M | must |
| [SYN-030](SYN-sync-engine.md#syn-030-author-commits-on-a-users-behalf-through-the-same-steps) | Author commits on a user's behalf through the same steps | enabler | M | must |
| [SYN-036](SYN-sync-engine.md#syn-036-publish-presence-positions-and-map-them-for-receivers) | Publish presence positions and map them for receivers | story | M | must |
| [SYN-037](SYN-sync-engine.md#syn-037-reject-expensive-commits-before-doing-the-work) | Reject expensive commits before doing the work | enabler | L | must |
| [SYN-039](SYN-sync-engine.md#syn-039-keep-heavy-work-off-the-rooms-event-loop) | Keep heavy work off the room's event loop | enabler | M | must |
| [SYN-049](SYN-sync-engine.md#syn-049-fuzz-the-authority) | Fuzz the authority | enabler | M | must |
| [SYN-050](SYN-sync-engine.md#syn-050-project-the-document-per-visibility-class) | Project the document per visibility class | enabler | L | must |
| [SYN-051](SYN-sync-engine.md#syn-051-send-each-commit-to-each-visibility-class) | Send each commit to each visibility class | enabler | M | must |
| [SYN-052](SYN-sync-engine.md#syn-052-map-and-vet-a-readers-commit) | Map and vet a reader's commit | enabler | M | must |
| [SYN-053](SYN-sync-engine.md#syn-053-close-and-reload-readers-whose-visibility-class-changes) | Close and reload readers whose visibility class changes | enabler | M | must |
| [PRM-003](PRM-permissions.md#prm-003-retire-a-regions-permission-data-when-the-region-is-deleted) | Retire a region's permission data when the region is deleted | story | M | must |
| [PRM-007](PRM-permissions.md#prm-007-let-grants-and-leases-expire-on-time) | Let grants and leases expire on time | story | S | must |
| [PRM-011](PRM-permissions.md#prm-011-restrict-structure-and-policy-changes-p2-and-p3) | Restrict structure and policy changes (P2 and P3) | story | L | must |
| [PRM-012](PRM-permissions.md#prm-012-protect-regions-from-changes-to-shared-definitions) | Protect regions from changes to shared definitions | story | L | must |
| [PRM-016](PRM-permissions.md#prm-016-keep-permission-indexes-current-and-the-check-cheap) | Keep permission indexes current and the check cheap | enabler | M | must |
| [PRM-021](PRM-permissions.md#prm-021-follow-document-roles-and-groups-through-token-refresh) | Follow document roles and groups through token refresh | story | M | must |
| [PRM-026](PRM-permissions.md#prm-026-show-which-regions-i-can-edit) | Show which regions I can edit | story | M | must |
| [PRM-028](PRM-permissions.md#prm-028-let-regions-behave-as-isolated-blocks-while-typing) | Let regions behave as isolated blocks while typing | story | L | must |
| [PRM-032](PRM-permissions.md#prm-032-list-the-documents-regions-and-who-can-edit-them) | List the document's regions and who can edit them | story | S | must |
| [PRM-033](PRM-permissions.md#prm-033-mark-blocks-as-a-region) | Mark blocks as a region | story | M | must |
| [PRM-035](PRM-permissions.md#prm-035-grant-roles-on-a-region-from-the-permissions-pane) | Grant roles on a region from the permissions pane | story | L | must |
| [PRM-036](PRM-permissions.md#prm-036-restrict-a-region-to-named-people) | Restrict a region to named people | story | S | must |
| [PRM-041](PRM-permissions.md#prm-041-keep-old-text-out-of-resume-and-catch-up) | Keep old text out of resume and catch-up | story | M | must |
| [PRM-051](PRM-permissions.md#prm-051-audit-rejected-commits-and-grant-changes) | Audit rejected commits and grant changes | story | M | must |
| [PRM-056](PRM-permissions.md#prm-056-hold-the-authorisation-matrix-as-data-and-enforce-it-from-one-table) | Hold the authorisation matrix as data and enforce it from one table | enabler | M | must |
| [PRM-057](PRM-permissions.md#prm-057-test-the-matrix-channel-commits-assets-export-and-service-routes) | Test the matrix: channel, commits, assets, export and service routes | enabler | M | must |
| [PRM-059](PRM-permissions.md#prm-059-test-threat-cases-forged-and-stale-commits) | Test threat cases: forged and stale commits | enabler | L | must |
| [PRM-066](PRM-permissions.md#prm-066-make-a-region-confidential-and-choose-its-readers) | Make a region confidential and choose its readers | story | M | must |
| [PRM-067](PRM-permissions.md#prm-067-work-out-each-connections-hidden-set-and-visibility-class) | Work out each connection's hidden set and visibility class | enabler | M | must |
| [PRO-014](PRO-protocol.md#pro-014-refresh-tokens-during-a-session) | Refresh tokens during a session | story | M | must |
| [PRO-018](PRO-protocol.md#pro-018-chunk-messages-that-exceed-the-message-limit) | Chunk messages that exceed the message limit | enabler | M | must |
| [PRO-019](PRO-protocol.md#pro-019-keep-the-connection-alive-and-reconnect-with-backoff) | Keep the connection alive and reconnect with backoff | story | M | must |
| [PRO-024](PRO-protocol.md#pro-024-close-channels-and-drain-connections) | Close channels and drain connections | story | M | must |
| [PRO-025](PRO-protocol.md#pro-025-join-with-catch-up-by-stream) | Join with catch-up by stream | story | L | must |
| [PRO-026](PRO-protocol.md#pro-026-join-with-catch-up-by-page-or-by-reload) | Join with catch-up by page or by reload | story | M | must |
| [PRO-035](PRO-protocol.md#pro-035-be-told-that-a-job-an-asset-or-the-document-changed) | Be told that a job, an asset or the document changed | story | M | must |
| [PRO-039](PRO-protocol.md#pro-039-act-on-each-error-code) | Act on each error code | story | M | must |
| [PRO-043](PRO-protocol.md#pro-043-retry-creating-requests-safely-with-idempotency-keys) | Retry creating requests safely with idempotency keys | story | M | must |
| [PRO-047](PRO-protocol.md#pro-047-read-update-lock-archive-and-delete-a-document) | Read, update, lock, archive and delete a document | story | M | must |
| [PRO-061](PRO-protocol.md#pro-061-upload-an-asset-through-quarantine) | Upload an asset through quarantine | story | M | must |
| [PRO-062](PRO-protocol.md#pro-062-resolve-asset-identifiers-to-short-lived-urls) | Resolve asset identifiers to short-lived URLs | story | S | must |
| [PRO-067](PRO-protocol.md#pro-067-read-the-font-manifest) | Read the font manifest | story | S | must |
| [PRO-077](PRO-protocol.md#pro-077-choose-the-mode-with-an-attribute) | Choose the mode with an attribute | story | S | must |
| [PRO-079](PRO-protocol.md#pro-079-choose-view-locale-theme-toolbar-and-keep-alive) | Choose view, locale, theme, toolbar and keep-alive | story | M | must |
| [PRO-083](PRO-protocol.md#pro-083-leave-a-page-without-losing-work) | Leave a page without losing work | story | S | must |
| [PRO-085](PRO-protocol.md#pro-085-drive-commands-from-the-host-page) | Drive commands from the host page | story | M | must |
| [PRO-089](PRO-protocol.md#pro-089-ask-the-host-to-show-its-own-sharing-dialog) | Ask the host to show its own sharing dialog | story | S | must |
| [PRO-090](PRO-protocol.md#pro-090-run-the-editor-on-any-backend-through-the-backend-property) | Run the editor on any backend through the `backend` property | story | S | must |
| [PRO-095](PRO-protocol.md#pro-095-backend-dep-resume-a-channel-and-catch-up) | `backend-dep`: resume a channel and catch up | enabler | M | must |
| [PRO-096](PRO-protocol.md#pro-096-backend-dep-implement-the-content-export-asset-and-font-ports) | `backend-dep`: implement the content, export, asset and font ports | enabler | M | must |
| [PRO-098](PRO-protocol.md#pro-098-run-one-set-of-port-contract-tests-against-every-backend) | Run one set of port contract tests against every backend | enabler | L | must |
| [PRO-099](PRO-protocol.md#pro-099-run-the-component-on-an-in-memory-mock-backend) | Run the component on an in-memory mock backend | story | M | must |
| [PRO-108](PRO-protocol.md#pro-108-run-the-kit-against-any-server-from-a-discovery-url) | Run the kit against any server from a discovery URL | enabler | L | must |
| [PRO-109](PRO-protocol.md#pro-109-offer-a-test-mode-switch-that-shortens-the-timers) | Offer a test-mode switch that shortens the timers | enabler | S | must |
| [PRO-110](PRO-protocol.md#pro-110-ship-golden-message-step-semantics-and-canonical-hash-fixtures) | Ship golden message, step-semantics and canonical-hash fixtures | enabler | M | must |
| [PRO-111](PRO-protocol.md#pro-111-provide-the-core-profile) | Provide the `core` profile | story | L | must |
| [PRO-112](PRO-protocol.md#pro-112-provide-the-presence-profile) | Provide the `presence` profile | story | S | must |
| [PRO-113](PRO-protocol.md#pro-113-provide-the-perm-doc-and-perm-region-profiles) | Provide the `perm-doc` and `perm-region` profiles | story | L | must |
| [PRO-114](PRO-protocol.md#pro-114-provide-the-assets-and-exports-profiles) | Provide the `assets` and `exports` profiles | story | M | must |
| [PRO-115](PRO-protocol.md#pro-115-test-every-authorisation-row-and-every-rejection-code-negatively) | Test every authorisation row and every rejection code negatively | enabler | M | must |
| [PRO-116](PRO-protocol.md#pro-116-fuzz-the-envelope-parser-and-step-validation) | Fuzz the envelope parser and step validation | enabler | M | must |
| [PRO-117](PRO-protocol.md#pro-117-keep-the-prose-the-artifacts-and-the-scenarios-in-step) | Keep the prose, the artifacts and the scenarios in step | enabler | M | must |
| [PRO-130](PRO-protocol.md#pro-130-carry-the-view-token-and-read-restrictions-in-dep) | Carry the view token and read restrictions in DEP | enabler | M | must |
| [PRO-131](PRO-protocol.md#pro-131-provide-the-perm-read-conformance-profile) | Provide the `perm-read` conformance profile | enabler | M | must |
| [BE-014](BE-backend.md#be-014-record-audit-events-in-an-append-only-partitioned-table) | Record audit events in an append-only partitioned table | enabler | M | must |
| [BE-016](BE-backend.md#be-016-change-the-schema-with-expand-and-contract-migrations) | Change the schema with expand-and-contract migrations | enabler | M | must |
| [BE-018](BE-backend.md#be-018-keep-a-node-lease-and-stop-serving-when-it-cannot-be-proved) | Keep a node lease and stop serving when it cannot be proved | enabler | M | must |
| [BE-020](BE-backend.md#be-020-write-checkpoints-from-the-durable-state) | Write checkpoints from the durable state | enabler | L | must |
| [BE-021](BE-backend.md#be-021-close-idle-rooms-and-bound-room-memory) | Close idle rooms and bound room memory | enabler | M | must |
| [BE-022](BE-backend.md#be-022-drain-a-node-on-deploy) | Drain a node on deploy | enabler | M | must |
| [BE-027](BE-backend.md#be-027-bound-each-channels-send-queue) | Bound each channel's send queue | enabler | M | must |
| [BE-030](BE-backend.md#be-030-rate-limit-by-address-connection-user-and-tenant) | Rate-limit by address, connection, user and tenant | enabler | M | must |
| [BE-034](BE-backend.md#be-034-make-creating-requests-idempotent) | Make creating requests idempotent | enabler | M | must |
| [BE-038](BE-backend.md#be-038-page-the-commit-log-for-catch-up) | Page the commit log for catch-up | story | S | must |
| [BE-039](BE-backend.md#be-039-deliver-server-authored-operations-through-an-outbox) | Deliver server-authored operations through an outbox | enabler | L | must |
| [BE-042](BE-backend.md#be-042-upload-an-image-into-quarantine) | Upload an image into quarantine | story | M | must |
| [BE-043](BE-backend.md#be-043-validate-re-encode-and-store-assets-in-a-sandboxed-worker) | Validate, re-encode and store assets in a sandboxed worker | enabler | L | must |
| [BE-044](BE-backend.md#be-044-attach-assets-to-documents-and-restrict-references) | Attach assets to documents and restrict references | enabler | M | must |
| [BE-045](BE-backend.md#be-045-serve-assets-by-short-lived-signed-url-from-a-separate-origin) | Serve assets by short-lived signed URL from a separate origin | story | M | must |
| [BE-047](BE-backend.md#be-047-serve-the-font-manifest) | Serve the font manifest | story | S | must |
| [BE-050](BE-backend.md#be-050-separate-previews-from-requested-exports-and-cap-tenants) | Separate previews from requested exports and cap tenants | enabler | M | must |
| [BE-052](BE-backend.md#be-052-run-scheduled-maintenance-jobs) | Run scheduled maintenance jobs | enabler | M | must |
| [BE-076](BE-backend.md#be-076-recover-after-a-room-host-crash) | Recover after a room host crash | story | L | must |
| [BE-077](BE-backend.md#be-077-reject-safely-while-postgresql-is-unavailable) | Reject safely while PostgreSQL is unavailable | story | M | must |
| [BE-078](BE-backend.md#be-078-give-a-document-a-new-incarnation-after-a-database-recovery) | Give a document a new incarnation after a database recovery | story | M | must |
| [BE-080](BE-backend.md#be-080-run-an-hour-of-faults-against-the-stage-1-service) | Run an hour of faults against the stage 1 service | enabler | L | must |
| [BE-081](BE-backend.md#be-081-rebuild-and-verify-a-document-from-a-checkpoint-and-the-log) | Rebuild and verify a document from a checkpoint and the log | enabler | M | must |
| [BE-084](BE-backend.md#be-084-measure-memory-per-open-document) | Measure memory per open document | spike | S | must |
| [BE-086](BE-backend.md#be-086-emit-metrics-per-node-and-per-tenant) | Emit metrics per node and per tenant | enabler | M | must |
| [BE-098](BE-backend.md#be-098-serve-projections-for-reads-outside-a-room) | Serve projections for reads outside a room | enabler | M | must |
| [SEC-005](SEC-security.md#sec-005-prove-hostile-document-content-cannot-run-script) | Prove hostile document content cannot run script | enabler | L | must |
| [SEC-006](SEC-security.md#sec-006-prove-links-and-images-are-safe) | Prove links and images are safe | enabler | M | must |
| [SEC-007](SEC-security.md#sec-007-prove-tokens-are-not-exposed-by-the-component) | Prove tokens are not exposed by the component | enabler | M | must |
| [SEC-015](SEC-security.md#sec-015-prove-replay-and-key-reuse-attacks-fail) | Prove replay and key-reuse attacks fail | enabler | M | must |
| [SEC-016](SEC-security.md#sec-016-prove-resources-cannot-be-reached-by-bare-identifier) | Prove resources cannot be reached by bare identifier | enabler | M | must |
| [SEC-018](SEC-security.md#sec-018-prove-resource-exhaustion-is-bounded) | Prove resource exhaustion is bounded | enabler | L | must |
| [SEC-022](SEC-security.md#sec-022-run-property-tests-for-fill-only-participants) | Run property tests for fill-only participants | enabler | M | must |
| [SEC-024](SEC-security.md#sec-024-prove-shared-definitions-cannot-deface-protected-text) | Prove shared definitions cannot deface protected text | enabler | M | must |
| [SEC-028](SEC-security.md#sec-028-prove-expensive-commits-cannot-stall-a-process) | Prove expensive commits cannot stall a process | enabler | L | must |
| [SEC-029](SEC-security.md#sec-029-prove-history-cannot-be-forged) | Prove history cannot be forged | enabler | L | must |
| [SEC-033](SEC-security.md#sec-033-prove-latex-injection-fails) | Prove LaTeX injection fails | enabler | L | must |
| [SEC-034](SEC-security.md#sec-034-prove-the-math-gate-holds) | Prove the math gate holds | enabler | L | must |
| [SEC-035](SEC-security.md#sec-035-prove-the-compile-sandbox-contains-a-compromised-compile) | Prove the compile sandbox contains a compromised compile | enabler | L | must |
| [SEC-036](SEC-security.md#sec-036-prove-worker-outputs-are-treated-as-hostile) | Prove worker outputs are treated as hostile | enabler | M | must |
| [SEC-037](SEC-security.md#sec-037-prove-uploads-cannot-claim-or-overwrite-assets) | Prove uploads cannot claim or overwrite assets | enabler | M | must |
| [SEC-038](SEC-security.md#sec-038-prove-decompression-and-pixel-bombs-are-contained) | Prove decompression and pixel bombs are contained | enabler | M | must |
| [SEC-040](SEC-security.md#sec-040-prove-decoder-exploits-and-type-confusion-are-contained) | Prove decoder exploits and type confusion are contained | enabler | M | must |
| [SEC-046](SEC-security.md#sec-046-prove-signed-urls-are-short-lived-single-object-and-checked) | Prove signed URLs are short-lived, single-object and checked | enabler | M | must |
| [SEC-051](SEC-security.md#sec-051-produce-a-software-bill-of-materials-per-release) | Produce a software bill of materials per release | enabler | S | must |
| [SEC-052](SEC-security.md#sec-052-sign-container-images-and-pin-base-images) | Sign container images and pin base images | enabler | M | must |
| [SEC-053](SEC-security.md#sec-053-pin-tex-live-and-ship-its-licence-manifest) | Pin TeX Live and ship its licence manifest | enabler | M | must |
| [SEC-054](SEC-security.md#sec-054-prove-the-editor-bundle-loads-no-third-party-code-at-run-time) | Prove the editor bundle loads no third-party code at run time | enabler | M | must |
| [SEC-060](SEC-security.md#sec-060-check-that-every-authorisation-row-and-rejection-code-has-a-negative-test) | Check that every authorisation row and rejection code has a negative test | enabler | M | must |
| [SEC-064](SEC-security.md#sec-064-prove-hidden-content-never-reaches-a-reader-without-access) | Prove hidden content never reaches a reader without access | enabler | L | must |
| [FE-005](FE-frontend.md#fe-005-survive-being-moved-in-the-dom) | Survive being moved in the DOM | story | M | must |
| [FE-006](FE-frontend.md#fe-006-destroy-the-editor-completely) | Destroy the editor completely | story | M | must |
| [FE-008](FE-frontend.md#fe-008-write-unconfirmed-commits-to-the-journal-before-sending-them) | Write unconfirmed commits to the journal before sending them | story | L | must |
| [FE-009](FE-frontend.md#fe-009-resubmit-journalled-work-on-the-next-visit) | Resubmit journalled work on the next visit | story | M | must |
| [FE-010](FE-frontend.md#fe-010-keep-recovered-edits) | Keep recovered edits | story | M | must |
| [FE-011](FE-frontend.md#fe-011-flush-the-journal-when-the-page-is-hidden) | Flush the journal when the page is hidden | story | S | must |
| [FE-012](FE-frontend.md#fe-012-wait-for-confirmation-with-flush) | Wait for confirmation with `flush` | story | S | must |
| [FE-017](FE-frontend.md#fe-017-publish-the-policy-names-and-directives-a-host-must-allow) | Publish the policy names and directives a host must allow | story | M | must |
| [FE-019](FE-frontend.md#fe-019-use-system-colours-under-forced-colors) | Use system colours under forced-colors | story | M | must |
| [FE-020](FE-frontend.md#fe-020-keep-menus-tooltips-and-dialogs-inside-the-shadow-root) | Keep menus, tooltips and dialogs inside the shadow root | story | M | must |
| [FE-027](FE-frontend.md#fe-027-read-and-insert-content-through-the-same-guards-as-typing) | Read and insert content through the same guards as typing | story | M | must |
| [FE-028](FE-frontend.md#fe-028-report-selection-and-command-state-changes) | Report selection and command-state changes | story | S | must |
| [FE-029](FE-frontend.md#fe-029-drive-the-editing-surface-from-the-mode) | Drive the editing surface from the mode | story | M | must |
| [FE-034](FE-frontend.md#fe-034-keep-composition-steady-when-remote-commits-arrive) | Keep composition steady when remote commits arrive | story | M | must |
| [FE-035](FE-frontend.md#fe-035-map-the-selection-and-decorations-through-every-rebuild) | Map the selection and decorations through every rebuild | story | M | must |
| [FE-037](FE-frontend.md#fe-037-delete-across-scopes-only-where-the-user-may-edit) | Delete across scopes only where the user may edit | story | M | must |
| [FE-040](FE-frontend.md#fe-040-edit-table-structure-with-the-projects-own-commands) | Edit table structure with the project's own commands | story | L | must |
| [FE-049](FE-frontend.md#fe-049-undo-and-redo-the-users-own-changes) | Undo and redo the user's own changes | story | L | must |
| [FE-050](FE-frontend.md#fe-050-copy-and-cut-with-the-document-fragment-embedded) | Copy and cut with the document fragment embedded | story | M | must |
| [FE-051](FE-frontend.md#fe-051-paste-an-embedded-fragment) | Paste an embedded fragment | story | M | must |
| [FE-052](FE-frontend.md#fe-052-paste-plain-text) | Paste plain text | story | S | must |
| [FE-053](FE-frontend.md#fe-053-paste-images-as-asset-uploads) | Paste images as asset uploads | story | M | must |
| [FE-056](FE-frontend.md#fe-056-run-sub-editors-whose-steps-map-onto-the-one-document) | Run sub-editors whose steps map onto the one document | enabler | L | must |
| [FE-057](FE-frontend.md#fe-057-edit-headers-and-footers-in-panels) | Edit headers and footers in panels | story | M | must |
| [FE-058](FE-frontend.md#fe-058-edit-footnotes-in-a-panel) | Edit footnotes in a panel | story | M | must |
| [FE-059](FE-frontend.md#fe-059-find-text-in-the-document) | Find text in the document | story | M | must |
| [FE-060](FE-frontend.md#fe-060-replace-one-match-or-all-skipping-locked-scopes) | Replace one match or all, skipping locked scopes | story | M | must |
| [FE-061](FE-frontend.md#fe-061-register-fonts-under-hash-derived-aliases) | Register fonts under hash-derived aliases | story | M | must |
| [FE-062](FE-frontend.md#fe-062-map-document-font-families-to-aliases) | Map document font families to aliases | story | M | must |
| [FE-065](FE-frontend.md#fe-065-select-the-view-with-the-view-attribute) | Select the view with the `view` attribute | story | M | must |
| [FE-066](FE-frontend.md#fe-066-edit-in-the-web-view) | Edit in the web view | story | L | must |
| [FE-067](FE-frontend.md#fe-067-render-document-content-without-executing-it) | Render document content without executing it | story | M | must |
| [FE-069](FE-frontend.md#fe-069-show-equations-on-screen) | Show equations on screen | story | M | must |
| [FE-070](FE-frontend.md#fe-070-edit-equations-with-the-math-editor) | Edit equations with the math editor | story | L | must |
| [FE-103](FE-frontend.md#fe-103-operate-the-editor-from-the-keyboard-and-leave-it-again) | Operate the editor from the keyboard and leave it again | story | M | must |
| [FE-104](FE-frontend.md#fe-104-give-every-drag-a-keyboard-or-dialog-alternative) | Give every drag a keyboard or dialog alternative | story | M | must |
| [FE-105](FE-frontend.md#fe-105-expose-numbered-paragraphs-as-lists-to-assistive-technology) | Expose numbered paragraphs as lists to assistive technology | story | M | must |
| [FE-106](FE-frontend.md#fe-106-reflow-the-web-view-for-people-who-zoom) | Reflow the web view for people who zoom | story | S | must |
| [FE-107](FE-frontend.md#fe-107-announce-saving-rejected-edits-and-collaborators) | Announce saving, rejected edits and collaborators | story | M | must |
| [FE-108](FE-frontend.md#fe-108-keep-aria-references-inside-the-shadow-root) | Keep ARIA references inside the shadow root | enabler | S | must |
| [FE-116](FE-frontend.md#fe-116-support-the-declared-browser-versions) | Support the declared browser versions | enabler | M | must |
| [FE-118](FE-frontend.md#fe-118-keep-typing-latency-within-budget-in-the-web-view) | Keep typing latency within budget in the web view | story | M | must |
| [FE-119](FE-frontend.md#fe-119-open-a-20-page-document-within-the-time-budget) | Open a 20-page document within the time budget | story | M | must |
| [FE-123](FE-frontend.md#fe-123-run-the-input-method-matrix) | Run the input-method matrix | enabler | L | must |
| [FE-124](FE-frontend.md#fe-124-run-the-host-matrix) | Run the host matrix | enabler | L | must |
| [FE-125](FE-frontend.md#fe-125-run-strict-content-security-policy-and-trusted-types-pages) | Run strict content security policy and Trusted Types pages | enabler | M | must |
| [FE-126](FE-frontend.md#fe-126-run-accessibility-checks-with-axe-and-screen-reader-passes) | Run accessibility checks with axe and screen-reader passes | enabler | M | must |
| [FE-128](FE-frontend.md#fe-128-format-characters) | Format characters | story | M | must |
| [FE-129](FE-frontend.md#fe-129-format-paragraphs) | Format paragraphs | story | M | must |
| [FE-130](FE-frontend.md#fe-130-create-multilevel-lists) | Create multilevel lists | story | M | must |
| [FE-132](FE-frontend.md#fe-132-insert-pictures-and-figures-with-captions-and-alternative-text) | Insert pictures and figures with captions and alternative text | story | M | must |
| [FE-133](FE-frontend.md#fe-133-insert-links-and-bookmarks) | Insert links and bookmarks | story | S | must |
| [FE-135](FE-frontend.md#fe-135-insert-breaks-page-sections-columns-and-footnotes) | Insert breaks, page sections, columns and footnotes | story | M | must |
| [FE-136](FE-frontend.md#fe-136-insert-fields-a-table-of-contents-symbols-and-equations) | Insert fields, a table of contents, symbols and equations | story | M | must |
| [FE-137](FE-frontend.md#fe-137-set-up-pages-headers-footers-and-the-watermark) | Set up pages, headers, footers and the watermark | story | M | must |
| [FE-140](FE-frontend.md#fe-140-insert-and-edit-citations-and-a-bibliography) | Insert and edit citations and a bibliography | story | M | must |
| [FE-141](FE-frontend.md#fe-141-render-placeholders-and-redacted-values) | Render placeholders and redacted values | story | M | must |
| [UX-005](UX-experience.md#ux-005-drive-the-editor-from-a-host-built-toolbar) | Drive the editor from a host-built toolbar | story | M | must |
| [UX-007](UX-experience.md#ux-007-full-toolbar-with-task-groups-and-contextual-groups) | Full toolbar with task groups and contextual groups | story | L | must |
| [UX-008](UX-experience.md#ux-008-context-menu) | Context menu | story | M | must |
| [UX-013](UX-experience.md#ux-013-keyboard-shortcuts-and-the-maintained-shortcut-table) | Keyboard shortcuts and the maintained shortcut table | story | M | must |
| [UX-015](UX-experience.md#ux-015-mode-switcher) | Mode switcher | story | M | must |
| [UX-017](UX-experience.md#ux-017-recovered-edits-pane) | Recovered edits pane | story | M | must |
| [UX-018](UX-experience.md#ux-018-status-bar) | Status bar | story | M | must |
| [UX-019](UX-experience.md#ux-019-pane-host) | Pane host | enabler | M | must |
| [UX-020](UX-experience.md#ux-020-navigation-pane-headings-and-search-results) | Navigation pane: headings and search results | story | M | must |
| [UX-022](UX-experience.md#ux-022-styles-gallery-and-styles-pane) | Styles gallery and styles pane | story | M | must |
| [UX-023](UX-experience.md#ux-023-move-between-shell-landmarks-by-keyboard) | Move between shell landmarks by keyboard | story | M | must |
| [UX-027](UX-experience.md#ux-027-collaborator-carets-with-name-flags) | Collaborator carets with name flags | story | M | must |
| [UX-039](UX-experience.md#ux-039-share-button) | Share button | story | S | must |
| [UX-061](UX-experience.md#ux-061-light-and-dark-themes) | Light and dark themes | story | M | must |
| [UX-062](UX-experience.md#ux-062-high-contrast-theme-and-forced-colours-behaviour-of-the-shell) | High-contrast theme and forced-colours behaviour of the shell | story | M | must |
| [UX-068](UX-experience.md#ux-068-the-shell-meets-wcag-22-level-aa) | The shell meets WCAG 2.2 level AA | story | L | must |
| [UX-069](UX-experience.md#ux-069-accessibility-conformance-report-for-every-release) | Accessibility conformance report for every release | enabler | M | must |
| [UX-070](UX-experience.md#ux-070-load-panes-proofing-and-the-assistant-on-demand) | Load panes, proofing and the assistant on demand | enabler | M | must |
| [UX-072](UX-experience.md#ux-072-typing-latency-with-the-shell-active) | Typing latency with the shell active | enabler | M | must |
| [UX-090](UX-experience.md#ux-090-integration-guide) | Integration guide | story | L | must |
| [UX-095](UX-experience.md#ux-095-reference-host-share-dialog) | Reference host: share dialog | story | M | must |
| [UX-096](UX-experience.md#ux-096-decision-semantics-of-the-dep-actor-header) | Decision: semantics of the `DEP-Actor` header | decision | S | must |
| [UX-097](UX-experience.md#ux-097-service-calls-on-behalf-of-a-user) | Service calls on behalf of a user | story | M | must |
| [UX-101](UX-experience.md#ux-101-export-dialog-with-progress-and-diagnostics) | Export dialog with progress and diagnostics | story | M | must |
| [HIS-005](HIS-history.md#his-005-rebuild-the-content-at-any-sequence-number) | Rebuild the content at any sequence number | enabler | M | must |
| [HIS-023](HIS-history.md#his-023-decide-the-exact-shape-of-the-visibility-gate) | Decide the exact shape of the visibility gate | decision | S | must |
| [HIS-024](HIS-history.md#his-024-enforce-one-visibility-gate-wherever-a-sequence-number-is-supplied) | Enforce one visibility gate wherever a sequence number is supplied | enabler | L | must |
| [HIS-033](HIS-history.md#his-033-verify-a-log-and-its-chain-with-a-command-line-tool) | Verify a log and its chain with a command-line tool | story | M | must |
| [EXP-002](EXP-export.md#exp-002-keep-the-converter-stateless-and-in-step-with-the-model) | Keep the converter stateless and in step with the model | enabler | M | must |
| [EXP-004](EXP-export.md#exp-004-create-an-export-job-and-follow-its-progress) | Create an export job and follow its progress | story | L | must |
| [EXP-005](EXP-export.md#exp-005-choose-export-options) | Choose export options | story | M | must |
| [EXP-007](EXP-export.md#exp-007-serve-previews-and-requested-exports-from-separate-queues) | Serve previews and requested exports from separate queues | enabler | M | must |
| [EXP-011](EXP-export.md#exp-011-assemble-the-bundle-and-its-manifest) | Assemble the bundle and its manifest | enabler | M | must |
| [EXP-012](EXP-export.md#exp-012-map-bundle-lines-back-to-blocks) | Map bundle lines back to blocks | enabler | M | must |
| [EXP-013](EXP-export.md#exp-013-generate-style-and-numbering-macros) | Generate style and numbering macros | enabler | M | must |
| [EXP-014](EXP-export.md#exp-014-put-images-into-the-bundle-by-content-hash) | Put images into the bundle by content hash | enabler | S | must |
| [EXP-015](EXP-export.md#exp-015-build-the-house-class-for-tagging-from-the-start) | Build the house class for tagging from the start | enabler | L | must |
| [EXP-016](EXP-export.md#exp-016-validate-every-reference-pdf-with-verapdf-in-ci) | Validate every reference PDF with veraPDF in CI | enabler | M | must |
| [EXP-017](EXP-export.md#exp-017-typeset-page-setups-and-sections) | Typeset page setups and sections | story | L | must |
| [EXP-018](EXP-export.md#exp-018-typeset-headers-and-footers) | Typeset headers and footers | story | M | must |
| [EXP-019](EXP-export.md#exp-019-print-page-reference-sequence-and-date-fields-correctly) | Print page, reference, sequence and date fields correctly | story | M | must |
| [EXP-020](EXP-export.md#exp-020-typeset-paragraph-styles-from-the-formatting-cascade) | Typeset paragraph styles from the formatting cascade | story | L | must |
| [EXP-021](EXP-export.md#exp-021-apply-the-models-paragraph-spacing-and-line-spacing) | Apply the model's paragraph spacing and line spacing | story | M | must |
| [EXP-022](EXP-export.md#exp-022-typeset-headings-with-working-bookmarks) | Typeset headings with working bookmarks | story | M | must |
| [EXP-024](EXP-export.md#exp-024-typeset-numbered-lists-with-literal-labels) | Typeset numbered lists with literal labels | story | M | must |
| [EXP-025](EXP-export.md#exp-025-typeset-text-runs-as-typed) | Typeset text runs as typed | story | M | must |
| [EXP-026](EXP-export.md#exp-026-fail-final-exports-on-missing-glyphs) | Fail final exports on missing glyphs | story | M | must |
| [EXP-027](EXP-export.md#exp-027-typeset-languages-without-rewriting-text) | Typeset languages without rewriting text | story | S | must |
| [EXP-028](EXP-export.md#exp-028-typeset-images-figures-and-captions) | Typeset images, figures and captions | story | L | must |
| [EXP-029](EXP-export.md#exp-029-typeset-footnotes) | Typeset footnotes | story | M | must |
| [EXP-030](EXP-export.md#exp-030-typeset-links-and-bookmarks) | Typeset links and bookmarks | story | M | must |
| [EXP-031](EXP-export.md#exp-031-map-line-page-and-column-breaks) | Map line, page and column breaks | story | S | must |
| [EXP-032](EXP-export.md#exp-032-typeset-tab-stops) | Typeset tab stops | story | M | must |
| [EXP-033](EXP-export.md#exp-033-flatten-form-field-values-into-the-pdf) | Flatten form-field values into the PDF | story | M | must |
| [EXP-038](EXP-export.md#exp-038-typeset-tables-in-the-body-flow) | Typeset tables in the body flow | story | L | must |
| [EXP-039](EXP-export.md#exp-039-split-table-rows-that-are-taller-than-a-page) | Split table rows that are taller than a page | story | M | must |
| [EXP-041](EXP-export.md#exp-041-typeset-row-spans-and-column-spans) | Typeset row spans and column spans | story | M | must |
| [EXP-043](EXP-export.md#exp-043-emit-pdf-strings-key-value-options-and-urls-safely) | Emit PDF strings, key-value options and URLs safely | enabler | M | must |
| [EXP-044](EXP-export.md#exp-044-emit-lengths-colours-and-enumerations-safely) | Emit lengths, colours and enumerations safely | enabler | M | must |
| [EXP-045](EXP-export.md#exp-045-allow-tex-output-only-through-the-emitters) | Allow TeX output only through the emitters | enabler | M | must |
| [EXP-046](EXP-export.md#exp-046-fuzz-the-emitters-per-context-and-per-language) | Fuzz the emitters per context and per language | enabler | L | must |
| [EXP-047](EXP-export.md#exp-047-load-fonts-from-the-manifest-by-hash) | Load fonts from the manifest by hash | enabler | M | must |
| [EXP-049](EXP-export.md#exp-049-gate-math-syntax-allow-list-and-forbidden-primitives) | Gate math: syntax, allow-list and forbidden primitives | enabler | L | must |
| [EXP-050](EXP-export.md#exp-050-gate-math-painting-dimensions-characters-and-limits) | Gate math: painting, dimensions, characters and limits | enabler | L | must |
| [EXP-051](EXP-export.md#exp-051-reject-bad-equations-at-edit-time-and-replace-them-at-export) | Reject bad equations at edit time and replace them at export | story | M | must |
| [EXP-052](EXP-export.md#exp-052-typeset-equations) | Typeset equations | story | L | must |
| [EXP-053](EXP-export.md#exp-053-fuzz-the-math-gate) | Fuzz the math gate | enabler | M | must |
| [EXP-055](EXP-export.md#exp-055-report-block-level-layout-in-layoutjson) | Report block-level layout in `layout.json` | enabler | L | must |
| [EXP-056](EXP-export.md#exp-056-check-layoutjson-against-the-pdf) | Check `layout.json` against the PDF | enabler | M | must |
| [EXP-060](EXP-export.md#exp-060-meet-the-export-latency-target) | Meet the export latency target | enabler | M | must |
| [EXP-061](EXP-export.md#exp-061-run-final-exports-to-convergence-from-a-clean-state) | Run final exports to convergence from a clean state | story | L | must |
| [EXP-062](EXP-export.md#exp-062-compile-previews-in-one-pass-with-draft-tagging) | Compile previews in one pass with draft tagging | story | M | must |
| [EXP-064](EXP-export.md#exp-064-parse-compile-logs-with-a-bounded-parser) | Parse compile logs with a bounded parser | enabler | L | must |
| [EXP-065](EXP-export.md#exp-065-show-diagnostics-at-the-blocks-they-come-from) | Show diagnostics at the blocks they come from | story | M | must |
| [EXP-067](EXP-export.md#exp-067-compile-only-bundles-that-came-from-the-converter) | Compile only bundles that came from the converter | enabler | M | must |
| [EXP-068](EXP-export.md#exp-068-harden-the-tex-engine-configuration) | Harden the TeX engine configuration | enabler | M | must |
| [EXP-069](EXP-export.md#exp-069-choose-the-sandbox-technology-for-compile-workers) | Choose the sandbox technology for compile workers | decision | S | must |
| [EXP-070](EXP-export.md#exp-070-run-every-job-in-a-single-use-sandbox) | Run every job in a single-use sandbox | enabler | L | must |
| [EXP-071](EXP-export.md#exp-071-enforce-per-job-limits) | Enforce per-job limits | enabler | M | must |
| [EXP-072](EXP-export.md#exp-072-keep-credentials-off-the-workers) | Keep credentials off the workers | enabler | S | must |
| [EXP-073](EXP-export.md#exp-073-build-the-curated-tex-live-image) | Build the curated TeX Live image | enabler | L | must |
| [EXP-075](EXP-export.md#exp-075-test-the-sandbox-adversarially) | Test the sandbox adversarially | enabler | L | must |
| [EXP-076](EXP-export.md#exp-076-reproduce-the-same-pdf-from-the-same-bundle) | Reproduce the same PDF from the same bundle | enabler | M | must |
| [EXP-111](EXP-export.md#exp-111-produce-tagged-accessible-pdf) | Produce tagged, accessible PDF | story | L | must |
| [EXP-112](EXP-export.md#exp-112-tag-tables-lists-headings-links-and-graphics) | Tag tables, lists, headings, links and graphics | story | M | must |
| [EXP-113](EXP-export.md#exp-113-report-images-without-alternative-text) | Report images without alternative text | story | S | must |
| [EXP-114](EXP-export.md#exp-114-add-reference-pdfs-to-the-shared-corpus) | Add reference PDFs to the shared corpus | enabler | L | must |
| [EXP-115](EXP-export.md#exp-115-run-the-shared-numbering-and-layout-fixtures-against-every-writer) | Run the shared numbering and layout fixtures against every writer | enabler | M | must |
| [EXP-121](EXP-export.md#exp-121-typeset-citations-and-bibliographies-with-biblatex) | Typeset citations and bibliographies with biblatex | story | M | must |
| [EXP-123](EXP-export.md#exp-123-export-as-the-requester) | Export as the requester | story | M | must |
| [FRW-001](FRW-fields-rules-workflow.md#frw-001-define-role-placeholders) | Define role placeholders | enabler | S | must |
| [FRW-002](FRW-fields-rules-workflow.md#frw-002-define-the-form-field-node) | Define the form field node | enabler | M | must |
| [FRW-003](FRW-fields-rules-workflow.md#frw-003-type-limit-and-store-field-values) | Type, limit and store field values | enabler | M | must |
| [FRW-005](FRW-fields-rules-workflow.md#frw-005-enforce-the-field-invariants-of-the-document-model) | Enforce the field invariants of the document model | enabler | M | must |
| [FRW-007](FRW-fields-rules-workflow.md#frw-007-add-the-fill-capability-the-filler-role-and-field-scopes) | Add the fill capability, the filler role and field scopes | enabler | M | must |
| [FRW-008](FRW-fields-rules-workflow.md#frw-008-let-a-fill-only-participant-change-only-the-values-of-their-own-fields) | Let a fill-only participant change only the values of their own fields | story | L | must |
| [FRW-009](FRW-fields-rules-workflow.md#frw-009-reserve-server-set-values-to-the-server) | Reserve server-set values to the server | enabler | M | must |
| [FRW-010](FRW-fields-rules-workflow.md#frw-010-reject-concurrent-fills-of-the-same-field) | Reject concurrent fills of the same field | story | M | must |
| [FRW-060](FRW-fields-rules-workflow.md#frw-060-read-fields-and-field-values) | Read fields and field values | story | M | must |
| [FRW-061](FRW-fields-rules-workflow.md#frw-061-prefill-field-values-by-key) | Prefill field values by key | story | M | must |
| [FRW-065](FRW-fields-rules-workflow.md#frw-065-announce-the-fields-features) | Announce the fields features | enabler | S | must |
| [FRW-066](FRW-fields-rules-workflow.md#frw-066-prove-fill-permissions-with-a-property-test) | Prove fill permissions with a property test | enabler | L | must |
| [FRW-067](FRW-fields-rules-workflow.md#frw-067-publish-the-fields-conformance-profile) | Publish the fields conformance profile | enabler | M | must |
| [FRW-069](FRW-fields-rules-workflow.md#frw-069-drive-fill-mode-through-the-embedding-api) | Drive fill mode through the embedding API | story | M | must |
| [FRW-070](FRW-fields-rules-workflow.md#frw-070-report-field-and-fill-progress-as-events) | Report field and fill progress as events | story | S | must |
| [FRW-072](FRW-fields-rules-workflow.md#frw-072-insert-fields-from-a-palette) | Insert fields from a palette | story | M | must |
| [FRW-073](FRW-fields-rules-workflow.md#frw-073-edit-a-fields-properties-in-a-panel) | Edit a field's properties in a panel | story | M | must |
| [FRW-074](FRW-fields-rules-workflow.md#frw-074-manage-roles-with-colour-and-icon) | Manage roles with colour and icon | story | M | must |
| [FRW-076](FRW-fields-rules-workflow.md#frw-076-fill-a-document-with-a-guided-bar) | Fill a document with a guided bar | story | L | must |
| [FRW-077](FRW-fields-rules-workflow.md#frw-077-see-which-fields-belong-to-other-roles) | See which fields belong to other roles | story | S | must |
| [FRW-079](FRW-fields-rules-workflow.md#frw-079-operate-every-field-by-keyboard-and-assistive-technology) | Operate every field by keyboard and assistive technology | story | M | must |
| [FRW-080](FRW-fields-rules-workflow.md#frw-080-keep-line-and-page-breaks-stable-while-filling) | Keep line and page breaks stable while filling | story | M | must |
| [FRW-088](FRW-fields-rules-workflow.md#frw-088-mark-a-field-value-sensitive-and-choose-its-readers) | Mark a field value sensitive and choose its readers | story | M | must |
| [FND-013](FND-foundations.md#fnd-013-documentation-site) | Documentation site | enabler | S | should |
| [CDM-023](CDM-document-model.md#cdm-023-map-pasted-definitions-onto-existing-ones) | Map pasted definitions onto existing ones | story | S | should |
| [CDM-040](CDM-document-model.md#cdm-040-suggest-changes-to-whole-paragraphs-rows-and-tables) | Suggest changes to whole paragraphs, rows and tables | story | M | should |
| [CDM-045](CDM-document-model.md#cdm-045-push-the-body-down-when-a-header-grows) | Push the body down when a header grows | story | S | should |
| [CDM-046](CDM-document-model.md#cdm-046-publish-writer-support-as-data) | Publish writer support as data | enabler | S | should |
| [SYN-031](SYN-sync-engine.md#syn-031-run-a-transient-authority-for-a-document-that-is-not-open) | Run a transient authority for a document that is not open | enabler | M | should |
| [SYN-038](SYN-sync-engine.md#syn-038-calibrate-the-sync-defaults-that-the-spec-calls-guesses) | Calibrate the sync defaults that the spec calls guesses | spike | M | should |
| [SYN-040](SYN-sync-engine.md#syn-040-benchmark-the-cost-of-a-typical-commit) | Benchmark the cost of a typical commit | enabler | S | should |
| [SYN-043](SYN-sync-engine.md#syn-043-detect-a-diverged-client-with-synccheck) | Detect a diverged client with `sync.check` | story | M | should |
| [SYN-046](SYN-sync-engine.md#syn-046-define-the-engine-extension-point) | Define the engine extension point | enabler | M | should |
| [PRM-005](PRM-permissions.md#prm-005-limit-capabilities-on-locked-and-archived-documents) | Limit capabilities on locked and archived documents | story | S | should |
| [PRM-027](PRM-permissions.md#prm-027-jump-to-the-next-region-i-can-edit) | Jump to the next region I can edit | story | S | should |
| [PRM-030](PRM-permissions.md#prm-030-keep-region-only-editors-out-of-definitions) | Keep region-only editors out of definitions | story | S | should |
| [PRM-034](PRM-permissions.md#prm-034-rename-remove-move-split-and-merge-regions) | Rename, remove, move, split and merge regions | story | M | should |
| [PRM-064](PRM-permissions.md#prm-064-decide-a-size-quota-for-region-only-editors) | Decide a size quota for region-only editors | decision | S | should |
| [PRM-065](PRM-permissions.md#prm-065-decide-what-happens-to-grants-policy-and-state-when-a-region-is-split-or-merged) | Decide what happens to grants, policy and state when a region is split or merged | decision | S | should |
| [PRO-013](PRO-protocol.md#pro-013-call-the-control-plane-with-a-signed-service-credential-and-act-for-a-user) | Call the control plane with a signed service credential and act for a user | story | M | should |
| [PRO-030](PRO-protocol.md#pro-030-reload-after-a-snapshot-and-detect-divergence) | Reload after a snapshot and detect divergence | story | M | should |
| [PRO-044](PRO-protocol.md#pro-044-trace-a-request-across-the-planes) | Trace a request across the planes | enabler | S | should |
| [PRO-050](PRO-protocol.md#pro-050-replace-document-content-as-an-import-snapshot) | Replace document content as an import snapshot | story | S | should |
| [PRO-081](PRO-protocol.md#pro-081-pass-configuration-to-the-element) | Pass configuration to the element | story | S | should |
| [PRO-084](PRO-protocol.md#pro-084-read-and-insert-content-from-the-host-page) | Read and insert content from the host page | story | M | should |
| [PRO-086](PRO-protocol.md#pro-086-export-and-print-from-the-host-page) | Export and print from the host page | story | M | should |
| [BE-006](BE-backend.md#be-006-install-the-service-with-a-helm-chart) | Install the service with a Helm chart | enabler | M | should |
| [BE-023](BE-backend.md#be-023-run-operations-on-closed-documents-in-a-transient-authority) | Run operations on closed documents in a transient authority | enabler | M | should |
| [BE-037](BE-backend.md#be-037-replace-a-documents-content-as-a-snapshot) | Replace a document's content as a snapshot | story | M | should |
| [BE-051](BE-backend.md#be-051-limit-preview-compiles-to-what-someone-is-viewing) | Limit preview compiles to what someone is viewing | enabler | S | should |
| [BE-058](BE-backend.md#be-058-hold-the-stage-1-targets-under-load) | Hold the stage 1 targets under load | enabler | L | should |
| [BE-079](BE-backend.md#be-079-expose-fault-injection-hooks-for-the-conformance-kit) | Expose fault-injection hooks for the conformance kit | enabler | M | should |
| [BE-085](BE-backend.md#be-085-meter-the-cost-drivers-per-tenant) | Meter the cost drivers per tenant | enabler | M | should |
| [BE-087](BE-backend.md#be-087-trace-requests-across-rest-rooms-and-jobs) | Trace requests across REST, rooms and jobs | enabler | M | should |
| [SEC-009](SEC-security.md#sec-009-prove-the-component-has-no-side-effects-on-the-host-page) | Prove the component has no side effects on the host page | enabler | M | should |
| [FE-015](FE-frontend.md#fe-015-fall-back-to-a-nonce-style-element) | Fall back to a nonce style element | story | S | should |
| [FE-073](FE-frontend.md#fe-073-print-the-typeset-pdf) | Print the typeset PDF | story | M | should |
| [FE-113](FE-frontend.md#fe-113-view-documents-on-a-mobile-browser) | View documents on a mobile browser | story | M | should |
| [FE-131](FE-frontend.md#fe-131-apply-table-styles-and-sort-rows) | Apply table styles and sort rows | story | M | should |
| [FE-134](FE-frontend.md#fe-134-insert-numbered-captions-and-cross-references) | Insert numbered captions and cross-references | story | M | should |
| [FE-138](FE-frontend.md#fe-138-zoom-the-editing-surface) | Zoom the editing surface | story | S | should |
| [UX-002](UX-experience.md#ux-002-report-parity-status-with-every-release) | Report parity status with every release | enabler | S | should |
| [UX-009](UX-experience.md#ux-009-format-painter) | Format painter | story | S | should |
| [UX-103](UX-experience.md#ux-103-manage-the-sources-of-a-document) | Manage the sources of a document | story | M | should |
| [UX-104](UX-experience.md#ux-104-explain-hidden-content-to-the-reader) | Explain hidden content to the reader | story | S | should |
| [EXP-003](EXP-export.md#exp-003-warn-before-export-about-content-that-will-not-typeset-well) | Warn before export about content that will not typeset well | story | M | should |
| [EXP-006](EXP-export.md#exp-006-return-the-first-result-for-the-same-bundle-and-profile) | Return the first result for the same bundle and profile | enabler | M | should |
| [EXP-008](EXP-export.md#exp-008-compile-previews-only-while-someone-is-looking) | Compile previews only while someone is looking | story | M | should |
| [EXP-023](EXP-export.md#exp-023-generate-tables-of-contents-and-lists-of-figures-and-tables) | Generate tables of contents and lists of figures and tables | story | M | should |
| [EXP-040](EXP-export.md#exp-040-typeset-tables-in-multi-column-sections) | Typeset tables in multi-column sections | story | M | should |
| [EXP-066](EXP-export.md#exp-066-give-raw-compile-logs-to-editors-only) | Give raw compile logs to editors only | story | S | should |
| [EXP-085](EXP-export.md#exp-085-download-the-latex-bundle) | Download the LaTeX bundle | story | M | should |
| [EXP-086](EXP-export.md#exp-086-export-the-canonical-json) | Export the canonical JSON | story | S | should |
| [FRW-004](FRW-fields-rules-workflow.md#frw-004-check-static-validation-limits-and-presets) | Check static validation limits and presets | story | M | should |
| [FRW-011](FRW-fields-rules-workflow.md#frw-011-keep-editing-rights-and-fill-rights-consistent) | Keep editing rights and fill rights consistent | story | S | should |
| [FRW-078](FRW-fields-rules-workflow.md#frw-078-review-required-and-invalid-fields-in-a-summary) | Review required and invalid fields in a summary | story | M | should |
| [PRM-063](PRM-permissions.md#prm-063-decide-whether-part-of-structure-can-be-granted-per-region) | Decide whether part of `structure` can be granted per region | decision | S | could |
| [FRW-006](FRW-fields-rules-workflow.md#frw-006-mirror-a-fields-value-elsewhere-in-the-document) | Mirror a field's value elsewhere in the document | story | S | could |

## Phase 2: review, history, workflow (281)

| Story | Title | Type | Size | Priority |
|---|---|---|---|---|
| [SPK-013](SPK-phase0.md#spk-013-decide-on-the-page-view-at-the-end-of-phase-2) | Decide on the page view at the end of phase 2 | decision | S | must |
| [SYN-032](SYN-sync-engine.md#syn-032-map-comment-ranges-through-every-commit) | Map comment ranges through every commit | enabler | M | must |
| [SYN-033](SYN-sync-engine.md#syn-033-map-a-requested-range-from-its-base-to-the-head-when-a-thread-is-created) | Map a requested range from its base to the head when a thread is created | enabler | M | must |
| [PRM-013](PRM-permissions.md#prm-013-compute-the-suggestion-baseline) | Compute the suggestion baseline | enabler | L | must |
| [PRM-014](PRM-permissions.md#prm-014-let-suggesters-propose-without-altering-the-baseline-p4) | Let suggesters propose without altering the baseline (P4) | story | L | must |
| [PRM-022](PRM-permissions.md#prm-022-end-a-users-sessions-on-the-hosts-request) | End a user's sessions on the host's request | story | M | must |
| [PRM-031](PRM-permissions.md#prm-031-keep-a-suggest-only-scope-in-suggestion-mode) | Keep a suggest-only scope in suggestion mode | story | M | must |
| [PRM-037](PRM-permissions.md#prm-037-comment-on-text-or-a-block-where-i-may-comment) | Comment on text or a block where I may comment | story | M | must |
| [PRM-038](PRM-permissions.md#prm-038-never-change-the-document-by-commenting) | Never change the document by commenting | story | M | must |
| [PRM-039](PRM-permissions.md#prm-039-resolve-reopen-assign-and-delete-threads) | Resolve, reopen, assign and delete threads | story | S | must |
| [PRM-042](PRM-permissions.md#prm-042-keep-old-text-out-of-every-other-history-surface) | Keep old text out of every other history surface | story | M | must |
| [PRM-046](PRM-permissions.md#prm-046-set-a-regions-state) | Set a region's state | story | M | must |
| [PRM-047](PRM-permissions.md#prm-047-make-an-approved-region-unchangeable) | Make an approved region unchangeable | story | L | must |
| [PRM-049](PRM-permissions.md#prm-049-check-rights-when-restoring) | Check rights when restoring | story | M | must |
| [PRM-052](PRM-permissions.md#prm-052-audit-the-other-permission-events) | Audit the other permission events | story | M | must |
| [PRM-058](PRM-permissions.md#prm-058-test-the-matrix-comments-versions-restore-leases-states-and-output-restrictions) | Test the matrix: comments, versions, restore, leases, states and output restrictions | enabler | M | must |
| [PRM-060](PRM-permissions.md#prm-060-test-threat-cases-suggestions-identity-revocation-visibility-and-load) | Test threat cases: suggestions, identity, revocation, visibility and load | enabler | L | must |
| [PRM-062](PRM-permissions.md#prm-062-specify-p4-for-block-level-suggestions) | Specify P4 for block-level suggestions | spike | M | must |
| [PRO-036](PRO-protocol.md#pro-036-be-told-about-threads-comments-versions-and-imports) | Be told about threads, comments, versions and imports | story | M | must |
| [PRO-054](PRO-protocol.md#pro-054-list-grouped-history-and-manage-named-versions) | List grouped history and manage named versions | story | M | must |
| [PRO-055](PRO-protocol.md#pro-055-compare-versions-and-read-attribution) | Compare versions and read attribution | story | M | must |
| [PRO-056](PRO-protocol.md#pro-056-restore-a-document-or-a-region) | Restore a document or a region | story | M | must |
| [PRO-059](PRO-protocol.md#pro-059-start-a-comment-thread-on-a-range-or-a-block) | Start a comment thread on a range or a block | story | M | must |
| [PRO-060](PRO-protocol.md#pro-060-resolve-reassign-reply-to-and-delete-threads-and-comments) | Resolve, reassign, reply to and delete threads and comments | story | M | must |
| [PRO-066](PRO-protocol.md#pro-066-import-a-word-file) | Import a Word file | story | M | must |
| [PRO-068](PRO-protocol.md#pro-068-manage-webhook-subscriptions) | Manage webhook subscriptions | story | M | must |
| [PRO-069](PRO-protocol.md#pro-069-wrap-every-webhook-in-a-cloudevents-envelope) | Wrap every webhook in a CloudEvents envelope | story | M | must |
| [PRO-070](PRO-protocol.md#pro-070-sign-every-webhook-request) | Sign every webhook request | story | M | must |
| [PRO-071](PRO-protocol.md#pro-071-deliver-at-least-once-and-only-to-public-addresses) | Deliver at least once and only to public addresses | story | M | must |
| [PRO-072](PRO-protocol.md#pro-072-raise-events-for-documents-versions-access-and-rejected-commits) | Raise events for documents, versions, access and rejected commits | story | M | must |
| [PRO-073](PRO-protocol.md#pro-073-raise-events-for-review-activity-and-for-jobs) | Raise events for review activity and for jobs | story | S | must |
| [PRO-097](PRO-protocol.md#pro-097-backend-dep-implement-the-history-comments-lease-and-import-ports) | `backend-dep`: implement the history, comments, lease and import ports | enabler | M | must |
| [PRO-118](PRO-protocol.md#pro-118-provide-the-perm-suggest-profile) | Provide the `perm-suggest` profile | story | M | must |
| [PRO-119](PRO-protocol.md#pro-119-provide-the-history-profile) | Provide the `history` profile | story | M | must |
| [PRO-120](PRO-protocol.md#pro-120-provide-the-comments-profile) | Provide the `comments` profile | story | M | must |
| [PRO-121](PRO-protocol.md#pro-121-provide-the-webhooks-profile) | Provide the `webhooks` profile | story | M | must |
| [PRO-123](PRO-protocol.md#pro-123-ship-the-rules-fixtures-in-the-kit) | Ship the rules fixtures in the kit | enabler | S | must |
| [BE-031](BE-backend.md#be-031-revoke-a-users-sessions) | Revoke a user's sessions | story | M | must |
| [BE-055](BE-backend.md#be-055-run-the-webhook-dispatcher) | Run the webhook dispatcher | story | L | must |
| [BE-056](BE-backend.md#be-056-refuse-private-addresses-through-an-egress-proxy) | Refuse private addresses through an egress proxy | enabler | M | must |
| [BE-096](BE-backend.md#be-096-encrypt-backups-and-audit-access-to-them) | Encrypt backups and audit access to them | enabler | M | must |
| [SEC-004](SEC-security.md#sec-004-commission-an-external-penetration-test-before-general-availability) | Commission an external penetration test before general availability | enabler | L | must |
| [SEC-010](SEC-security.md#sec-010-prove-prompt-injection-cannot-cause-side-effects) | Prove prompt injection cannot cause side effects | enabler | M | must |
| [SEC-014](SEC-security.md#sec-014-prove-revocation-holds-on-both-planes) | Prove revocation holds on both planes | enabler | M | must |
| [SEC-020](SEC-security.md#sec-020-prove-webhooks-cannot-be-forged-or-aimed-inward) | Prove webhooks cannot be forged or aimed inward | enabler | M | must |
| [SEC-023](SEC-security.md#sec-023-run-property-tests-for-suggestion-only-users) | Run property tests for suggestion-only users | enabler | M | must |
| [SEC-030](SEC-security.md#sec-030-prove-an-approved-region-cannot-be-changed-by-any-origin) | Prove an approved region cannot be changed by any origin | enabler | M | must |
| [SEC-032](SEC-security.md#sec-032-prove-old-versions-cannot-leak-deleted-text) | Prove old versions cannot leak deleted text | enabler | M | must |
| [SEC-039](SEC-security.md#sec-039-prove-docx-import-cannot-be-abused) | Prove DOCX import cannot be abused | enabler | L | must |
| [SEC-041](SEC-security.md#sec-041-prove-signing-keys-never-reach-content-workers) | Prove signing keys never reach content workers | enabler | M | must |
| [SEC-042](SEC-security.md#sec-042-prove-a-tampered-pdf-cannot-be-sealed) | Prove a tampered PDF cannot be sealed | enabler | M | must |
| [SEC-044](SEC-security.md#sec-044-prove-evidence-stays-outside-the-log) | Prove evidence stays outside the log | enabler | M | must |
| [SEC-048](SEC-security.md#sec-048-prove-secrets-are-managed-and-rotated-with-overlap) | Prove secrets are managed and rotated with overlap | enabler | M | must |
| [SEC-049](SEC-security.md#sec-049-prove-backups-are-encrypted-and-access-is-audited) | Prove backups are encrypted and access is audited | enabler | M | must |
| [SEC-056](SEC-security.md#sec-056-prove-users-are-known-only-as-surrogates-and-erasure-works) | Prove users are known only as surrogates and erasure works | enabler | M | must |
| [SEC-057](SEC-security.md#sec-057-prove-deletion-and-retention-remove-what-they-promise) | Prove deletion and retention remove what they promise | enabler | M | must |
| [FE-041](FE-frontend.md#fe-041-enter-suggestion-mode-by-rule) | Enter suggestion mode by rule | story | M | must |
| [FE-042](FE-frontend.md#fe-042-record-typing-and-deletion-as-suggestions) | Record typing and deletion as suggestions | story | L | must |
| [FE-043](FE-frontend.md#fe-043-suggest-formatting-changes) | Suggest formatting changes | story | M | must |
| [FE-044](FE-frontend.md#fe-044-suggest-paragraph-and-block-changes) | Suggest paragraph and block changes | story | L | must |
| [FE-045](FE-frontend.md#fe-045-suggest-table-row-and-cell-changes) | Suggest table row and cell changes | story | L | must |
| [FE-046](FE-frontend.md#fe-046-show-suggestions-in-the-editing-surface) | Show suggestions in the editing surface | story | M | must |
| [FE-047](FE-frontend.md#fe-047-accept-and-reject-suggestions) | Accept and reject suggestions | story | L | must |
| [FE-048](FE-frontend.md#fe-048-draw-comment-ranges-and-keep-them-aligned) | Draw comment ranges and keep them aligned | story | M | must |
| [FE-054](FE-frontend.md#fe-054-paste-html-through-the-sanitiser-and-the-word-and-google-docs-cleaners) | Paste HTML through the sanitiser and the Word and Google Docs cleaners | story | L | must |
| [FE-072](FE-frontend.md#fe-072-open-the-read-view-on-the-typeset-pdf) | Open the read view on the typeset PDF | story | M | must |
| [FE-139](FE-frontend.md#fe-139-show-preserved-content-with-its-fallback-and-change-it-only-as-a-whole) | Show preserved content with its fallback and change it only as a whole | story | M | must |
| [UX-028](UX-experience.md#ux-028-start-a-comment-thread-on-a-range-or-a-block) | Start a comment thread on a range or a block | story | L | must |
| [UX-029](UX-experience.md#ux-029-reply-edit-resolve-reopen-and-delete) | Reply, edit, resolve, reopen and delete | story | M | must |
| [UX-030](UX-experience.md#ux-030-comments-pane) | Comments pane | story | M | must |
| [UX-031](UX-experience.md#ux-031-mention-people-in-a-comment) | Mention people in a comment | story | M | must |
| [UX-032](UX-experience.md#ux-032-assign-a-thread-as-a-task) | Assign a thread as a task | story | M | must |
| [UX-035](UX-experience.md#ux-035-markup-views) | Markup views | story | M | must |
| [UX-036](UX-experience.md#ux-036-review-suggestions-one-by-one-or-all-at-once) | Review suggestions one by one or all at once | story | M | must |
| [UX-037](UX-experience.md#ux-037-review-pane) | Review pane | story | M | must |
| [UX-040](UX-experience.md#ux-040-output-restrictions-in-the-editor) | Output restrictions in the editor | story | M | must |
| [UX-044](UX-experience.md#ux-044-decision-how-an-assistants-agent-identity-is-established-and-capped) | Decision: how an assistant's agent identity is established and capped | decision | S | must |
| [UX-046](UX-experience.md#ux-046-assistant-writes-arrive-as-suggestions) | Assistant writes arrive as suggestions | story | L | must |
| [UX-047](UX-experience.md#ux-047-limit-the-assistants-context-to-what-the-user-may-view) | Limit the assistant's context to what the user may view | story | M | must |
| [UX-048](UX-experience.md#ux-048-prompt-injection-controls-for-the-assistant) | Prompt-injection controls for the assistant | story | L | must |
| [UX-049](UX-experience.md#ux-049-spike-the-document-api-offered-to-extensions-and-its-versioning) | Spike: the document API offered to extensions and its versioning | spike | M | must |
| [UX-050](UX-experience.md#ux-050-register-host-extensions) | Register host extensions | enabler | L | must |
| [UX-051](UX-experience.md#ux-051-extensions-add-commands-toolbar-groups-context-menu-items-and-shortcuts) | Extensions add commands, toolbar groups, context-menu items and shortcuts | story | M | must |
| [UX-052](UX-experience.md#ux-052-extensions-add-side-panels-and-status-bar-items) | Extensions add side panels and status-bar items | story | M | must |
| [UX-053](UX-experience.md#ux-053-extensions-read-and-change-the-document-through-a-range-based-api) | Extensions read and change the document through a range-based API | story | L | must |
| [UX-054](UX-experience.md#ux-054-extension-hooks-stay-off-the-typing-path) | Extension hooks stay off the typing path | enabler | S | must |
| [UX-056](UX-experience.md#ux-056-custom-blocks) | Custom blocks | story | L | must |
| [UX-058](UX-experience.md#ux-058-fallback-when-the-extension-is-missing) | Fallback when the extension is missing | story | M | must |
| [UX-066](UX-experience.md#ux-066-accessibility-checker-find-issues) | Accessibility checker: find issues | story | L | must |
| [UX-067](UX-experience.md#ux-067-accessibility-checker-act-on-issues) | Accessibility checker: act on issues | story | M | must |
| [UX-076](UX-experience.md#ux-076-define-the-administration-api) | Define the administration API | enabler | L | must |
| [UX-077](UX-experience.md#ux-077-register-token-keys-and-allowed-origins) | Register token keys and allowed origins | story | M | must |
| [UX-080](UX-experience.md#ux-080-retention-policy-and-legal-hold-administration) | Retention policy and legal hold administration | story | M | must |
| [UX-081](UX-experience.md#ux-081-audit-query) | Audit query | story | M | must |
| [UX-098](UX-experience.md#ux-098-reference-host-webhook-receiver-and-e-mail-notifications) | Reference host: webhook receiver and e-mail notifications | story | L | must |
| [UX-099](UX-experience.md#ux-099-reference-host-send-for-completion) | Reference host: send for completion | story | L | must |
| [HIS-006](HIS-history.md#his-006-name-a-version) | Name a version | story | S | must |
| [HIS-007](HIS-history.md#his-007-create-versions-for-exports-restores-imports-and-workflows) | Create versions for exports, restores, imports and workflows | enabler | M | must |
| [HIS-008](HIS-history.md#his-008-list-history-grouped-by-day-and-editing-session) | List history grouped by day and editing session | story | M | must |
| [HIS-009](HIS-history.md#his-009-browse-history-in-a-panel) | Browse history in a panel | story | L | must |
| [HIS-010](HIS-history.md#his-010-open-a-read-only-view-of-an-old-version) | Open a read-only view of an old version | story | L | must |
| [HIS-011](HIS-history.md#his-011-compute-comparisons-from-the-recorded-steps) | Compute comparisons from the recorded steps | enabler | L | must |
| [HIS-012](HIS-history.md#his-012-compute-comparisons-by-aligning-blocks) | Compute comparisons by aligning blocks | enabler | L | must |
| [HIS-013](HIS-history.md#his-013-compare-two-versions-in-the-editor) | Compare two versions in the editor | story | L | must |
| [HIS-014](HIS-history.md#his-014-maintain-the-attribution-map) | Maintain the attribution map | enabler | L | must |
| [HIS-015](HIS-history.md#his-015-see-who-wrote-a-passage) | See who wrote a passage | story | M | must |
| [HIS-016](HIS-history.md#his-016-see-who-filled-a-field) | See who filled a field | story | S | must |
| [HIS-017](HIS-history.md#his-017-tell-apart-what-a-person-wrote-and-what-an-assistant-wrote-for-them) | Tell apart what a person wrote and what an assistant wrote for them | story | M | must |
| [HIS-018](HIS-history.md#his-018-restore-one-region-to-an-earlier-version) | Restore one region to an earlier version | story | L | must |
| [HIS-019](HIS-history.md#his-019-restore-the-whole-document) | Restore the whole document | story | M | must |
| [HIS-020](HIS-history.md#his-020-re-check-restores-when-they-are-applied) | Re-check restores when they are applied | enabler | M | must |
| [HIS-025](HIS-history.md#his-025-choose-who-sees-full-history) | Choose who sees full history | story | M | must |
| [HIS-026](HIS-history.md#his-026-prove-the-gate-with-negative-tests-on-every-endpoint) | Prove the gate with negative tests on every endpoint | enabler | M | must |
| [HIS-027](HIS-history.md#his-027-record-read-markers-and-serve-the-activity-since-the-marker) | Record read markers and serve the activity since the marker | enabler | M | must |
| [HIS-028](HIS-history.md#his-028-catch-up-on-what-changed-since-my-last-visit) | Catch up on what changed since my last visit | story | L | must |
| [HIS-034](HIS-history.md#his-034-publish-chain-heads-to-hosts-and-in-export-manifests) | Publish chain heads to hosts and in export manifests | enabler | M | must |
| [HIS-035](HIS-history.md#his-035-decide-how-often-heads-are-anchored-and-at-what-granularity) | Decide how often heads are anchored and at what granularity | decision | S | must |
| [HIS-036](HIS-history.md#his-036-anchor-signed-time-stamped-heads-in-write-once-storage) | Anchor signed, time-stamped heads in write-once storage | enabler | L | must |
| [HIS-038](HIS-history.md#his-038-erase-a-person-from-history) | Erase a person from history | story | M | must |
| [HIS-039](HIS-history.md#his-039-erase-a-document-and-everything-derived-from-it) | Erase a document and everything derived from it | story | L | must |
| [HIS-043](HIS-history.md#his-043-evaluate-comparison-quality-for-moved-content-tables-and-styles) | Evaluate comparison quality for moved content, tables and styles | spike | L | must |
| [HIS-046](HIS-history.md#his-046-project-history-surfaces-with-the-requesters-current-access) | Project history surfaces with the requester's current access | enabler | L | must |
| [EXP-034](EXP-export.md#exp-034-flatten-signature-initials-date-signed-and-formula-values) | Flatten signature, initials, date-signed and formula values | story | M | must |
| [EXP-054](EXP-export.md#exp-054-choose-the-converter-between-latex-and-office-math) | Choose the converter between LaTeX and Office math | spike | M | must |
| [EXP-079](EXP-export.md#exp-079-compare-two-independent-compiles-before-sealing) | Compare two independent compiles before sealing | enabler | M | must |
| [EXP-081](EXP-export.md#exp-081-export-with-all-suggestions-accepted-or-all-rejected) | Export with all suggestions accepted or all rejected | story | M | must |
| [EXP-082](EXP-export.md#exp-082-refuse-an-export-that-would-ship-unreviewed-suggestions) | Refuse an export that would ship unreviewed suggestions | story | S | must |
| [EXP-090](EXP-export.md#exp-090-write-docx-text-styles-and-numbering) | Write DOCX text, styles and numbering | story | L | must |
| [EXP-091](EXP-export.md#exp-091-write-docx-tables-images-and-captions) | Write DOCX tables, images and captions | story | L | must |
| [EXP-092](EXP-export.md#exp-092-write-docx-page-structure-notes-and-references) | Write DOCX page structure, notes and references | story | L | must |
| [EXP-093](EXP-export.md#exp-093-write-suggestions-and-comments-to-docx) | Write suggestions and comments to DOCX | story | M | must |
| [EXP-094](EXP-export.md#exp-094-write-regions-to-docx) | Write regions to DOCX | story | L | must |
| [EXP-095](EXP-export.md#exp-095-write-form-fields-to-docx) | Write form fields to DOCX | story | M | must |
| [EXP-096](EXP-export.md#exp-096-write-math-to-docx) | Write math to DOCX | story | M | must |
| [EXP-097](EXP-export.md#exp-097-choose-the-parser-to-build-the-docx-importer-on) | Choose the parser to build the DOCX importer on | spike | M | must |
| [EXP-098](EXP-export.md#exp-098-import-a-word-file-as-a-job) | Import a Word file as a job | story | L | must |
| [EXP-099](EXP-export.md#exp-099-read-the-docx-package-safely) | Read the DOCX package safely | enabler | L | must |
| [EXP-100](EXP-export.md#exp-100-import-text-styles-and-numbering) | Import text, styles and numbering | story | L | must |
| [EXP-101](EXP-export.md#exp-101-import-tables-images-and-figures) | Import tables, images and figures | story | L | must |
| [EXP-102](EXP-export.md#exp-102-import-sections-headers-footers-notes-fields-and-links) | Import sections, headers, footers, notes, fields and links | story | L | must |
| [EXP-103](EXP-export.md#exp-103-import-tracked-changes-as-suggestions-with-author-labels) | Import tracked changes as suggestions with author labels | story | M | must |
| [EXP-105](EXP-export.md#exp-105-import-office-math) | Import Office math | story | M | must |
| [EXP-106](EXP-export.md#exp-106-substitute-fonts-and-warn-about-reflow) | Substitute fonts and warn about reflow | story | M | must |
| [EXP-107](EXP-export.md#exp-107-report-what-the-import-dropped-or-approximated) | Report what the import dropped or approximated | story | M | must |
| [EXP-108](EXP-export.md#exp-108-keep-the-original-word-file-as-an-immutable-asset) | Keep the original Word file as an immutable asset | enabler | S | must |
| [EXP-109](EXP-export.md#exp-109-validate-imported-content-against-the-model) | Validate imported content against the model | enabler | M | must |
| [EXP-110](EXP-export.md#exp-110-fuzz-and-test-the-importer) | Fuzz and test the importer | enabler | L | must |
| [EXP-116](EXP-export.md#exp-116-record-a-source-map-and-keep-unknown-properties-on-import) | Record a source map and keep unknown properties on import | story | L | must |
| [EXP-117](EXP-export.md#exp-117-import-content-the-model-cannot-represent-as-preserved-atoms) | Import content the model cannot represent as preserved atoms | story | L | must |
| [EXP-118](EXP-export.md#exp-118-write-docx-by-patching-the-original-package) | Write DOCX by patching the original package | story | L | must |
| [EXP-119](EXP-export.md#exp-119-put-preserved-fragments-back-and-renumber-their-relationships) | Put preserved fragments back and renumber their relationships | enabler | M | must |
| [EXP-120](EXP-export.md#exp-120-prove-lossless-round-trip-in-ci) | Prove lossless round trip in CI | enabler | M | must |
| [EXP-122](EXP-export.md#exp-122-write-and-read-citations-and-bibliographies-in-docx) | Write and read citations and bibliographies in DOCX | story | M | must |
| [FRW-014](FRW-fields-rules-workflow.md#frw-014-fix-the-rule-semantics-the-spec-leaves-open) | Fix the rule semantics the spec leaves open | spike | S | must |
| [FRW-015](FRW-fields-rules-workflow.md#frw-015-build-the-rules-package-model-and-validation) | Build the rules package: model and validation | enabler | L | must |
| [FRW-016](FRW-fields-rules-workflow.md#frw-016-evaluate-conditions-with-strict-typed-comparison) | Evaluate conditions with strict typed comparison | enabler | M | must |
| [FRW-017](FRW-fields-rules-workflow.md#frw-017-evaluate-formulas-on-decimal-strings) | Evaluate formulas on decimal strings | enabler | M | must |
| [FRW-018](FRW-fields-rules-workflow.md#frw-018-match-patterns-in-linear-time) | Match patterns in linear time | enabler | M | must |
| [FRW-019](FRW-fields-rules-workflow.md#frw-019-evaluate-in-dependency-order-and-refuse-cycles) | Evaluate in dependency order and refuse cycles | enabler | M | must |
| [FRW-020](FRW-fields-rules-workflow.md#frw-020-pin-rule-behaviour-with-conformance-fixtures) | Pin rule behaviour with conformance fixtures | enabler | M | must |
| [FRW-021](FRW-fields-rules-workflow.md#frw-021-store-rules-and-roles-in-the-definitions-and-freeze-them-at-send) | Store rules and roles in the definitions and freeze them at send | story | S | must |
| [FRW-022](FRW-fields-rules-workflow.md#frw-022-enforce-visibility-and-enablement-in-the-authority) | Enforce visibility and enablement in the authority | story | M | must |
| [FRW-023](FRW-fields-rules-workflow.md#frw-023-apply-rules-live-in-the-editor) | Apply rules live in the editor | story | L | must |
| [FRW-025](FRW-fields-rules-workflow.md#frw-025-define-the-workflow-resource) | Define the workflow resource | enabler | L | must |
| [FRW-026](FRW-fields-rules-workflow.md#frw-026-bind-people-to-roles-and-order-them) | Bind people to roles and order them | story | M | must |
| [FRW-027](FRW-fields-rules-workflow.md#frw-027-send-a-document-for-completion) | Send a document for completion | story | L | must |
| [FRW-028](FRW-fields-rules-workflow.md#frw-028-run-the-pre-send-checklist-in-the-editor) | Run the pre-send checklist in the editor | story | M | must |
| [FRW-029](FRW-fields-rules-workflow.md#frw-029-lock-the-document-while-a-workflow-runs) | Lock the document while a workflow runs | story | M | must |
| [FRW-030](FRW-fields-rules-workflow.md#frw-030-record-workflow-transitions-as-control-commits) | Record workflow transitions as control commits | enabler | M | must |
| [FRW-031](FRW-fields-rules-workflow.md#frw-031-activate-participants-in-order) | Activate participants in order | story | M | must |
| [FRW-032](FRW-fields-rules-workflow.md#frw-032-correct-a-document-in-progress-and-resume) | Correct a document in progress and resume | story | L | must |
| [FRW-033](FRW-fields-rules-workflow.md#frw-033-decline-or-void-a-workflow) | Decline or void a workflow | story | M | must |
| [FRW-035](FRW-fields-rules-workflow.md#frw-035-push-workflow-state-to-connected-clients) | Push workflow state to connected clients | enabler | M | must |
| [FRW-036](FRW-fields-rules-workflow.md#frw-036-leave-all-messages-to-the-host) | Leave all messages to the host | story | M | must |
| [FRW-038](FRW-fields-rules-workflow.md#frw-038-admit-participants-with-host-minted-tokens) | Admit participants with host-minted tokens | story | M | must |
| [FRW-040](FRW-fields-rules-workflow.md#frw-040-record-evidence-per-participant) | Record evidence per participant | story | L | must |
| [FRW-041](FRW-fields-rules-workflow.md#frw-041-keep-evidence-outside-the-commit-log) | Keep evidence outside the commit log | enabler | M | must |
| [FRW-044](FRW-fields-rules-workflow.md#frw-044-accept-the-consent-text-before-signing) | Accept the consent text before signing | story | M | must |
| [FRW-045](FRW-fields-rules-workflow.md#frw-045-adopt-a-signature) | Adopt a signature | story | L | must |
| [FRW-046](FRW-fields-rules-workflow.md#frw-046-sign-signature-and-initials-fields) | Sign signature and initials fields | story | L | must |
| [FRW-047](FRW-fields-rules-workflow.md#frw-047-complete-my-part-of-the-workflow) | Complete my part of the workflow | story | L | must |
| [FRW-048](FRW-fields-rules-workflow.md#frw-048-sign-without-drawing-or-a-pointer) | Sign without drawing or a pointer | story | M | must |
| [FRW-049](FRW-fields-rules-workflow.md#frw-049-produce-the-final-pdf-at-completion) | Produce the final PDF at completion | story | L | must |
| [FRW-050](FRW-fields-rules-workflow.md#frw-050-add-a-certificate-of-completion) | Add a certificate of completion | story | M | must |
| [FRW-052](FRW-fields-rules-workflow.md#frw-052-run-a-signing-service-that-holds-the-keys) | Run a signing service that holds the keys | enabler | L | must |
| [FRW-053](FRW-fields-rules-workflow.md#frw-053-seal-the-final-pdf-with-a-time-stamp) | Seal the final PDF with a time-stamp | story | L | must |
| [FRW-054](FRW-fields-rules-workflow.md#frw-054-store-the-sealed-pdf-immutably-and-anchor-the-chain-head) | Store the sealed PDF immutably and anchor the chain head | enabler | M | must |
| [FRW-055](FRW-fields-rules-workflow.md#frw-055-export-an-evidence-bundle-for-third-party-verification) | Export an evidence bundle for third-party verification | story | L | must |
| [FRW-058](FRW-fields-rules-workflow.md#frw-058-keep-signing-language-within-the-legal-stance) | Keep signing language within the legal stance | enabler | S | must |
| [FRW-068](FRW-fields-rules-workflow.md#frw-068-publish-the-workflow-sign-and-seal-conformance-profiles) | Publish the workflow, sign and seal conformance profiles | enabler | L | must |
| [FRW-071](FRW-fields-rules-workflow.md#frw-071-finish-or-decline-filling-through-the-embedding-api) | Finish or decline filling through the embedding API | story | M | must |
| [FRW-084](FRW-fields-rules-workflow.md#frw-084-decide-the-default-evidence-retention-period) | Decide the default evidence retention period | decision | S | must |
| [FRW-086](FRW-fields-rules-workflow.md#frw-086-decide-how-a-role-writes-a-long-formatted-answer-in-a-locked-document) | Decide how a role writes a long formatted answer in a locked document | decision | S | must |
| [FRW-087](FRW-fields-rules-workflow.md#frw-087-obtain-legal-review-of-the-signing-claims-before-launch) | Obtain legal review of the signing claims before launch | decision | S | must |
| [FRW-089](FRW-fields-rules-workflow.md#frw-089-hide-values-derived-from-hidden-content) | Hide values derived from hidden content | enabler | M | must |
| [CDM-049](CDM-document-model.md#cdm-049-write-migrations-as-pure-functions-with-fixtures) | Write migrations as pure functions with fixtures | enabler | M | should |
| [CDM-050](CDM-document-model.md#cdm-050-support-two-cdm-versions-side-by-side-and-keep-older-packages) | Support two CDM versions side by side and keep older packages | enabler | M | should |
| [PRM-015](PRM-permissions.md#prm-015-require-suggestions-from-everyone-when-the-document-says-so) | Require suggestions from everyone when the document says so | story | M | should |
| [PRM-023](PRM-permissions.md#prm-023-grant-a-region-role-to-a-workflow-role-placeholder) | Grant a region role to a workflow role placeholder | story | S | should |
| [PRM-040](PRM-permissions.md#prm-040-limit-threads-per-document) | Limit threads per document | story | S | should |
| [PRM-043](PRM-permissions.md#prm-043-acquire-and-release-a-region-lease) | Acquire and release a region lease | story | M | should |
| [PRM-044](PRM-permissions.md#prm-044-keep-a-lease-alive-and-let-it-end) | Keep a lease alive and let it end | story | S | should |
| [PRM-045](PRM-permissions.md#prm-045-break-another-persons-lease) | Break another person's lease | story | S | should |
| [PRM-048](PRM-permissions.md#prm-048-show-a-regions-state-and-why-it-is-locked) | Show a region's state and why it is locked | story | S | should |
| [PRM-050](PRM-permissions.md#prm-050-fall-back-when-a-restored-region-needs-a-missing-definition) | Fall back when a restored region needs a missing definition | story | S | should |
| [PRM-053](PRM-permissions.md#prm-053-tell-the-host-about-permission-events) | Tell the host about permission events | story | S | should |
| [PRO-015](PRO-protocol.md#pro-015-carry-optional-claims-for-history-visibility-output-restrictions-and-participants) | Carry optional claims for history visibility, output restrictions and participants | story | S | should |
| [PRO-016](PRO-protocol.md#pro-016-end-a-users-access-before-the-token-expires) | End a user's access before the token expires | story | M | should |
| [PRO-034](PRO-protocol.md#pro-034-receive-permission-changes-caused-by-region-states-leases-and-workflow) | Receive permission changes caused by region states, leases and workflow | story | S | should |
| [PRO-053](PRO-protocol.md#pro-053-set-region-states-and-acquire-leases) | Set region states and acquire leases | story | M | should |
| [PRO-057](PRO-protocol.md#pro-057-fork-a-document-from-the-host) | Fork a document from the host | story | S | should |
| [PRO-058](PRO-protocol.md#pro-058-track-what-changed-since-the-last-visit) | Track what changed since the last visit | story | S | should |
| [PRO-065](PRO-protocol.md#pro-065-refuse-exports-that-need-a-decision) | Refuse exports that need a decision | story | S | should |
| [PRO-078](PRO-protocol.md#pro-078-start-in-suggestion-mode) | Start in suggestion mode | story | S | should |
| [PRO-082](PRO-protocol.md#pro-082-register-host-extensions-through-the-extensions-property) | Register host extensions through the `extensions` property | story | S | should |
| [PRO-122](PRO-protocol.md#pro-122-provide-the-leases-profile) | Provide the `leases` profile | story | S | should |
| [BE-015](BE-backend.md#be-015-create-the-tables-for-history-comments-region-states-and-leases) | Create the tables for history, comments, region states and leases | enabler | M | should |
| [BE-041](BE-backend.md#be-041-separate-and-encrypt-each-tenants-objects) | Separate and encrypt each tenant's objects | enabler | M | should |
| [BE-053](BE-backend.md#be-053-decide-the-design-of-cross-document-search) | Decide the design of cross-document search | spike | M | should |
| [BE-054](BE-backend.md#be-054-index-document-text-after-checkpoints) | Index document text after checkpoints | enabler | M | should |
| [BE-057](BE-backend.md#be-057-rotate-secrets-send-test-pings-and-replay-deliveries) | Rotate secrets, send test pings and replay deliveries | story | M | should |
| [BE-089](BE-backend.md#be-089-debug-a-broken-document-without-reading-it) | Debug a broken document without reading it | story | M | should |
| [BE-090](BE-backend.md#be-090-repair-a-broken-document-with-an-audited-commit) | Repair a broken document with an audited commit | story | M | should |
| [BE-091](BE-backend.md#be-091-enforce-live-use-quotas-per-tenant) | Enforce live-use quotas per tenant | enabler | M | should |
| [BE-092](BE-backend.md#be-092-enforce-storage-and-export-quotas-per-tenant) | Enforce storage and export quotas per tenant | enabler | M | should |
| [BE-094](BE-backend.md#be-094-run-cdm-migrations-only-when-an-operator-starts-them) | Run CDM migrations only when an operator starts them | story | M | should |
| [SEC-043](SEC-security.md#sec-043-prove-product-language-does-not-over-claim) | Prove product language does not over-claim | enabler | S | should |
| [SEC-062](SEC-security.md#sec-062-decide-key-management-for-per-document-and-tenant-owned-keys) | Decide key management for per-document and tenant-owned keys | decision | S | should |
| [FE-055](FE-frontend.md#fe-055-block-clipboard-writes-and-printing-under-no-copy-and-no-print) | Block clipboard writes and printing under no-copy and no-print | story | S | should |
| [FE-120](FE-frontend.md#fe-120-keep-long-documents-usable-in-the-web-view) | Keep long documents usable in the web view | story | M | should |
| [UX-010](UX-experience.md#ux-010-mini-toolbar) | Mini toolbar | story | S | should |
| [UX-011](UX-experience.md#ux-011-command-search) | Command search | story | M | should |
| [UX-012](UX-experience.md#ux-012-access-keys) | Access keys | story | M | should |
| [UX-034](UX-experience.md#ux-034-link-to-a-comment) | Link to a comment | story | S | should |
| [UX-038](UX-experience.md#ux-038-require-tracked-changes-for-everyone) | Require tracked changes for everyone | story | S | should |
| [UX-041](UX-experience.md#ux-041-show-spelling-and-grammar-findings-from-the-proofing-port) | Show spelling and grammar findings from the proofing port | story | L | should |
| [UX-042](UX-experience.md#ux-042-act-on-a-finding-and-manage-custom-dictionaries) | Act on a finding and manage custom dictionaries | story | M | should |
| [UX-045](UX-experience.md#ux-045-assistant-pane) | Assistant pane | story | L | should |
| [UX-057](UX-experience.md#ux-057-custom-inline-content) | Custom inline content | story | S | should |
| [UX-063](UX-experience.md#ux-063-replace-icons-and-strings) | Replace icons and strings | story | M | should |
| [UX-074](UX-experience.md#ux-074-memory-for-a-100-page-document) | Memory for a 100-page document | enabler | S | should |
| [UX-078](UX-experience.md#ux-078-quotas-and-usage-figures) | Quotas and usage figures | story | M | should |
| [UX-079](UX-experience.md#ux-079-manage-fonts-and-webhooks-through-the-administration-api) | Manage fonts and webhooks through the administration API | story | S | should |
| [UX-082](UX-experience.md#ux-082-audit-streaming-export) | Audit streaming export | story | M | should |
| [UX-102](UX-experience.md#ux-102-rulers-for-indents-tab-stops-and-margins) | Rulers for indents, tab stops and margins | story | M | should |
| [HIS-021](HIS-history.md#his-021-preview-a-restore-with-a-dry-run) | Preview a restore with a dry run | story | S | should |
| [HIS-022](HIS-history.md#his-022-copy-a-version-into-a-new-document) | Copy a version into a new document | story | M | should |
| [HIS-029](HIS-history.md#his-029-move-old-payloads-to-cold-segments) | Move old payloads to cold segments | enabler | L | should |
| [HIS-030](HIS-history.md#his-030-thin-checkpoints-with-age) | Thin checkpoints with age | enabler | M | should |
| [HIS-031](HIS-history.md#his-031-place-a-legal-hold-on-a-document) | Place a legal hold on a document | story | M | should |
| [HIS-037](HIS-history.md#his-037-export-a-log-segment-for-third-party-verification) | Export a log segment for third-party verification | story | M | should |
| [HIS-040](HIS-history.md#his-040-replace-one-commits-payload-with-a-tombstone) | Replace one commit's payload with a tombstone | enabler | M | should |
| [HIS-042](HIS-history.md#his-042-show-suggestion-decisions-in-history) | Show suggestion decisions in history | story | S | should |
| [HIS-044](HIS-history.md#his-044-measure-the-size-of-the-attribution-map-on-large-documents) | Measure the size of the attribution map on large documents | spike | M | should |
| [HIS-045](HIS-history.md#his-045-decide-how-long-old-packages-stay-runnable-for-replay) | Decide how long old packages stay runnable for replay | decision | S | should |
| [EXP-009](EXP-export.md#exp-009-limit-a-tenants-compile-minutes) | Limit a tenant's compile minutes | story | S | should |
| [EXP-010](EXP-export.md#exp-010-refuse-export-for-restricted-callers-and-run-the-hosts-policy-hook) | Refuse export for restricted callers and run the host's policy hook | story | M | should |
| [EXP-035](EXP-export.md#exp-035-typeset-extension-content-through-its-fallback) | Typeset extension content through its fallback | story | S | should |
| [EXP-048](EXP-export.md#exp-048-use-tenant-fonts-only-in-that-tenants-jobs) | Use tenant fonts only in that tenant's jobs | story | M | should |
| [EXP-078](EXP-export.md#exp-078-gate-tex-live-and-class-upgrades-on-reference-pdfs) | Gate TeX Live and class upgrades on reference PDFs | enabler | M | should |
| [EXP-083](EXP-export.md#exp-083-show-suggestions-as-markup-in-the-pdf) | Show suggestions as markup in the PDF | story | L | should |
| [EXP-084](EXP-export.md#exp-084-show-comments-in-the-margin) | Show comments in the margin | story | L | should |
| [EXP-087](EXP-export.md#exp-087-export-html) | Export HTML | story | M | should |
| [EXP-088](EXP-export.md#exp-088-export-markdown) | Export Markdown | story | M | should |
| [EXP-104](EXP-export.md#exp-104-import-editable-ranges-as-regions) | Import editable ranges as regions | story | M | should |
| [FRW-012](FRW-fields-rules-workflow.md#frw-012-grant-a-region-to-a-role-placeholder) | Grant a region to a role placeholder | story | M | should |
| [FRW-024](FRW-fields-rules-workflow.md#frw-024-build-a-rule-as-a-sentence) | Build a rule as a sentence | story | L | should |
| [FRW-034](FRW-fields-rules-workflow.md#frw-034-expire-at-the-deadline-and-send-reminders) | Expire at the deadline and send reminders | story | M | should |
| [FRW-039](FRW-fields-rules-workflow.md#frw-039-protect-a-participants-access-with-an-access-code) | Protect a participant's access with an access code | story | M | should |
| [FRW-042](FRW-fields-rules-workflow.md#frw-042-switch-off-ip-address-and-user-agent-capture) | Switch off IP address and user agent capture | story | S | should |
| [FRW-043](FRW-fields-rules-workflow.md#frw-043-remove-evidence-at-the-end-of-its-retention) | Remove evidence at the end of its retention | story | M | should |
| [FRW-075](FRW-fields-rules-workflow.md#frw-075-preview-the-document-as-a-role) | Preview the document as a role | story | M | should |
| [FRW-085](FRW-fields-rules-workflow.md#frw-085-decide-whether-comments-are-switched-off-during-a-workflow) | Decide whether comments are switched off during a workflow | decision | S | should |
| [BE-046](BE-backend.md#be-046-delete-assets-that-no-document-references) | Delete assets that no document references | enabler | S | could |
| [BE-048](BE-backend.md#be-048-add-tenant-supplied-fonts) | Add tenant-supplied fonts | story | M | could |
| [FE-068](FE-frontend.md#fe-068-draw-optional-page-guides-from-compile-results) | Draw optional page guides from compile results | story | S | could |
| [FE-117](FE-frontend.md#fe-117-publish-a-compatibility-list-for-browser-extensions) | Publish a compatibility list for browser extensions | story | S | could |
| [UX-033](UX-experience.md#ux-033-react-to-a-comment) | React to a comment | story | S | could |
| [UX-043](UX-experience.md#ux-043-spike-dictionaries-and-licences-for-a-built-in-fallback-spell-checker) | Spike: dictionaries and licences for a built-in fallback spell checker | spike | S | could |
| [UX-055](UX-experience.md#ux-055-client-import-and-export-filters-from-extensions) | Client import and export filters from extensions | story | S | could |
| [EXP-036](EXP-export.md#exp-036-print-page-number-format-page-number-start-and-watermark) | Print page number format, page number start and watermark | story | M | could |

## Phase 3: pages (gated on SPK-013) (35)

| Story | Title | Type | Size | Priority |
|---|---|---|---|---|
| [FE-063](FE-frontend.md#fe-063-register-the-same-aliases-in-workers) | Register the same aliases in workers | enabler | S | must |
| [FE-064](FE-frontend.md#fe-064-wait-for-fonts-and-advance-the-font-epoch) | Wait for fonts and advance the font epoch | enabler | M | must |
| [FE-075](FE-frontend.md#fe-075-decide-whether-layout-runs-in-a-worker) | Decide whether layout runs in a worker | decision | S | must |
| [FE-076](FE-frontend.md#fe-076-define-the-layout-engine-api-and-its-injected-interfaces) | Define the layout engine API and its injected interfaces | enabler | L | must |
| [FE-077](FE-frontend.md#fe-077-convert-the-document-into-flow-blocks) | Convert the document into flow blocks | enabler | M | must |
| [FE-078](FE-frontend.md#fe-078-build-the-immutable-layout-tree) | Build the immutable layout tree | enabler | M | must |
| [FE-079](FE-frontend.md#fe-079-measure-text-through-an-injected-provider-with-a-cache) | Measure text through an injected provider with a cache | enabler | M | must |
| [FE-080](FE-frontend.md#fe-080-find-line-break-opportunities-with-the-unicode-line-breaking-algorithm) | Find line-break opportunities with the Unicode line breaking algorithm | enabler | M | must |
| [FE-081](FE-frontend.md#fe-081-break-paragraphs-into-lines-first-fit) | Break paragraphs into lines, first-fit | enabler | M | must |
| [FE-082](FE-frontend.md#fe-082-paginate-with-break-keep-and-widow-rules) | Paginate with break, keep and widow rules | story | L | must |
| [FE-083](FE-frontend.md#fe-083-split-tables-across-pages) | Split tables across pages | story | L | must |
| [FE-084](FE-frontend.md#fe-084-place-footnotes-on-their-pages) | Place footnotes on their pages | story | L | must |
| [FE-085](FE-frontend.md#fe-085-lay-out-columns-and-balance-them) | Lay out columns and balance them | story | M | must |
| [FE-086](FE-frontend.md#fe-086-lay-out-page-sections-with-their-own-size-and-orientation) | Lay out page sections with their own size and orientation | story | M | must |
| [FE-087](FE-frontend.md#fe-087-place-headers-and-footers-on-each-page) | Place headers and footers on each page | story | M | must |
| [FE-088](FE-frontend.md#fe-088-re-lay-out-incrementally) | Re-lay out incrementally | story | L | must |
| [FE-089](FE-frontend.md#fe-089-paginate-long-documents-in-the-background) | Paginate long documents in the background | enabler | M | must |
| [FE-090](FE-frontend.md#fe-090-paint-lines-the-browser-cannot-re-wrap) | Paint lines the browser cannot re-wrap | story | L | must |
| [FE-091](FE-frontend.md#fe-091-justify-with-computed-word-spacing) | Justify with computed word spacing | story | S | must |
| [FE-092](FE-frontend.md#fe-092-virtualise-the-painted-pages) | Virtualise the painted pages | story | L | must |
| [FE-093](FE-frontend.md#fe-093-provide-an-interactive-overlay-layer) | Provide an interactive overlay layer | story | M | must |
| [FE-094](FE-frontend.md#fe-094-test-the-layout-engine-and-the-painter-in-ci) | Test the layout engine and the painter in CI | enabler | M | must |
| [FE-095](FE-frontend.md#fe-095-paint-read-only-pages-for-the-read-view-old-versions-and-page-counts) | Paint read-only pages for the read view, old versions and page counts | story | L | must |
| [FE-096](FE-frontend.md#fe-096-place-the-caret-and-selection-from-the-layout-tree) | Place the caret and selection from the layout tree | story | L | must |
| [FE-097](FE-frontend.md#fe-097-move-by-line-page-home-and-end) | Move by line, page, Home and End | story | M | must |
| [FE-098](FE-frontend.md#fe-098-type-into-the-page-view-through-the-input-bridge) | Type into the page view through the input bridge | story | L | must |
| [FE-099](FE-frontend.md#fe-099-read-and-edit-the-page-view-with-a-screen-reader) | Read and edit the page view with a screen reader | story | L | must |
| [FE-100](FE-frontend.md#fe-100-reconcile-page-breaks-with-the-typeset-result) | Reconcile page breaks with the typeset result | story | L | must |
| [FE-101](FE-frontend.md#fe-101-offer-the-editable-page-view-as-viewprint) | Offer the editable page view as `view="print"` | story | M | must |
| [FE-102](FE-frontend.md#fe-102-keep-the-page-view-within-its-budgets) | Keep the page view within its budgets | enabler | M | must |
| [EXP-057](EXP-export.md#exp-057-report-line-level-layout) | Report line-level layout | enabler | L | must |
| [EXP-058](EXP-export.md#exp-058-report-the-rectangle-of-every-form-field) | Report the rectangle of every form field | enabler | M | must |
| [UX-021](UX-experience.md#ux-021-navigation-pane-page-thumbnails) | Navigation pane: page thumbnails | story | M | could |
| [EXP-059](EXP-export.md#exp-059-decide-whether-forced-line-breaks-parity-level-l2-are-built) | Decide whether forced line breaks (parity level L2) are built | decision | S | could |
| [FRW-057](FRW-fields-rules-workflow.md#frw-057-show-visible-signature-appearances-at-the-field-positions) | Show visible signature appearances at the field positions | story | M | could |

## Phase 4: scale, interoperability, reach (51)

| Story | Title | Type | Size | Priority |
|---|---|---|---|---|
| [BE-059](BE-backend.md#be-059-decide-the-internal-bus) | Decide the internal bus | decision | S | must |
| [BE-060](BE-backend.md#be-060-route-each-document-to-one-owning-node) | Route each document to one owning node | enabler | L | must |
| [BE-062](BE-backend.md#be-062-forward-channels-between-nodes-over-the-bus) | Forward channels between nodes over the bus | enabler | L | must |
| [BE-063](BE-backend.md#be-063-share-presence-rate-limits-and-the-bus-through-redis-or-valkey) | Share presence, rate limits and the bus through Redis or Valkey | enabler | M | must |
| [PRO-100](PRO-protocol.md#pro-100-run-the-component-on-a-local-indexeddb-backend) | Run the component on a local IndexedDB backend | story | L | should |
| [PRO-101](PRO-protocol.md#pro-101-declare-what-a-backend-of-each-tier-may-announce) | Declare what a backend of each tier may announce | story | M | should |
| [PRO-102](PRO-protocol.md#pro-102-choose-a-wire-binding-for-the-authority-service) | Choose a wire binding for the authority service | spike | S | should |
| [PRO-103](PRO-protocol.md#pro-103-load-and-materialise-documents-in-the-authority-service) | Load and materialise documents in the authority service | story | M | should |
| [PRO-104](PRO-protocol.md#pro-104-apply-a-commit-in-the-authority-service) | Apply a commit in the authority service | story | L | should |
| [PRO-105](PRO-protocol.md#pro-105-map-ranges-through-commits-in-the-authority-service) | Map ranges through commits in the authority service | story | S | should |
| [PRO-106](PRO-protocol.md#pro-106-compute-restore-steps-comparisons-and-attribution-in-the-authority-service) | Compute restore steps, comparisons and attribution in the authority service | story | M | should |
| [PRO-107](PRO-protocol.md#pro-107-migrate-documents-and-evaluate-rules-in-the-authority-service) | Migrate documents and evaluate rules in the authority service | story | M | should |
| [PRO-124](PRO-protocol.md#pro-124-provide-the-core-relay-profile) | Provide the `core-relay` profile | story | M | should |
| [PRO-125](PRO-protocol.md#pro-125-provide-the-authority-service-profile) | Provide the `authority-service` profile | story | M | should |
| [PRO-127](PRO-protocol.md#pro-127-publish-the-kit) | Publish the kit | story | M | should |
| [BE-061](BE-backend.md#be-061-tell-clients-which-node-owns-their-document) | Tell clients which node owns their document | story | M | should |
| [BE-064](BE-backend.md#be-064-serve-control-plane-reads-from-replicas) | Serve control-plane reads from replicas | enabler | M | should |
| [BE-065](BE-backend.md#be-065-autoscale-export-workers-on-queue-depth) | Autoscale export workers on queue depth | enabler | M | should |
| [BE-066](BE-backend.md#be-066-meet-the-stage-2-targets-under-load) | Meet the stage 2 targets under load | enabler | L | should |
| [FE-111](FE-frontend.md#fe-111-edit-right-to-left-and-complex-script-content-in-the-web-view) | Edit right-to-left and complex-script content in the web view | story | L | should |
| [FE-114](FE-frontend.md#fe-114-edit-lightly-on-a-mobile-browser) | Edit lightly on a mobile browser | story | L | should |
| [FE-115](FE-frontend.md#fe-115-make-input-methods-work-on-ios-safari-inside-shadow-roots) | Make input methods work on iOS Safari inside shadow roots | spike | M | should |
| [UX-065](UX-experience.md#ux-065-mirror-the-interface-for-right-to-left-locales) | Mirror the interface for right-to-left locales | story | M | should |
| [UX-085](UX-experience.md#ux-085-classification-label) | Classification label | story | M | should |
| [UX-088](UX-experience.md#ux-088-tenant-export) | Tenant export | story | L | should |
| [EXP-037](EXP-export.md#exp-037-typeset-right-to-left-and-complex-script-text) | Typeset right-to-left and complex-script text | story | M | should |
| [EXP-077](EXP-export.md#exp-077-scale-workers-on-queue-depth) | Scale workers on queue depth | enabler | M | should |
| [FRW-056](FRW-fields-rules-workflow.md#frw-056-add-long-term-validation-and-renew-time-stamps) | Add long-term validation and renew time-stamps | story | L | should |
| [FRW-062](FRW-fields-rules-workflow.md#frw-062-create-a-document-from-a-template) | Create a document from a template | story | L | should |
| [SYN-041](SYN-sync-engine.md#syn-041-coalesce-broadcasts-for-rooms-with-many-subscribers) | Coalesce broadcasts for rooms with many subscribers | enabler | M | could |
| [SYN-044](SYN-sync-engine.md#syn-044-offer-a-relay-mode-for-backends-that-cannot-run-the-document-model) | Offer a relay mode for backends that cannot run the document model | enabler | M | could |
| [SYN-045](SYN-sync-engine.md#syn-045-tolerate-a-confirmed-step-that-fails-to-apply) | Tolerate a confirmed step that fails to apply | enabler | S | could |
| [PRO-048](PRO-protocol.md#pro-048-mark-a-document-with-a-classification-label) | Mark a document with a classification label | story | S | could |
| [PRO-126](PRO-protocol.md#pro-126-provide-the-optional-fault-injection-profile) | Provide the optional fault-injection profile | story | M | could |
| [BE-004](BE-backend.md#be-004-store-files-in-azure-blob-storage) | Store files in Azure Blob Storage | enabler | M | could |
| [BE-007](BE-backend.md#be-007-deploy-the-authority-service-as-a-container) | Deploy the authority service as a container | enabler | M | could |
| [BE-067](BE-backend.md#be-067-decide-whether-follower-nodes-are-needed-before-stage-3) | Decide whether follower nodes are needed before stage 3 | spike | S | could |
| [SEC-011](SEC-security.md#sec-011-decide-the-policy-for-browser-extensions-that-read-or-edit-content) | Decide the policy for browser extensions that read or edit content | decision | S | could |
| [SEC-063](SEC-security.md#sec-063-decide-whether-to-anchor-chain-heads-in-a-public-transparency-log) | Decide whether to anchor chain heads in a public transparency log | decision | S | could |
| [UX-059](UX-experience.md#ux-059-decision-build-sandboxed-third-party-extensions) | Decision: build sandboxed third-party extensions? | decision | S | could |
| [UX-084](UX-experience.md#ux-084-search-documents-for-a-host-catalogue) | Search documents for a host catalogue | story | M | could |
| [UX-086](UX-experience.md#ux-086-policy-hook-for-data-loss-prevention) | Policy hook for data-loss prevention | story | M | could |
| [UX-087](UX-experience.md#ux-087-discovery-export) | Discovery export | story | L | could |
| [UX-089](UX-experience.md#ux-089-administration-console) | Administration console | story | L | could |
| [UX-100](UX-experience.md#ux-100-reference-host-template-gallery) | Reference host: template gallery | story | M | could |
| [HIS-032](HIS-history.md#his-032-let-a-tenant-thin-old-payloads) | Let a tenant thin old payloads | story | M | could |
| [HIS-041](HIS-history.md#his-041-delete-a-documents-history-by-destroying-its-key) | Delete a document's history by destroying its key | story | L | could |
| [EXP-089](EXP-export.md#exp-089-mark-exports-with-the-classification-label) | Mark exports with the classification label | story | S | could |
| [FRW-037](FRW-fields-rules-workflow.md#frw-037-route-by-rules) | Route by rules | story | L | could |
| [FRW-059](FRW-fields-rules-workflow.md#frw-059-sign-through-a-signature-provider) | Sign through a signature provider | story | L | could |
| [FRW-063](FRW-fields-rules-workflow.md#frw-063-send-a-template-to-many-recipients) | Send a template to many recipients | story | L | could |

## Conditional: only if a decision or spike goes a certain way (see each story's Notes) (43)

| Story | Title | Type | Size | Priority |
|---|---|---|---|---|
| [SPK-022](SPK-phase0.md#spk-022-s9-the-page-views-input-bridge-and-screen-reader-plan) | S9: the page view's input bridge and screen-reader plan | spike | L | must |
| [BE-082](BE-backend.md#be-082-recover-hosted-deployments-within-the-stated-objectives) | Recover hosted deployments within the stated objectives | enabler | M | must |
| [WASM-001](WASM-rust-kernels.md#wasm-001-rust-workspace-and-build-toolchain) | Rust workspace and build toolchain | enabler | M | must |
| [WASM-002](WASM-rust-kernels.md#wasm-002-load-webassembly-modules-on-demand-inside-the-element) | Load WebAssembly modules on demand inside the element | enabler | M | must |
| [WASM-003](WASM-rust-kernels.md#wasm-003-keep-editing-when-the-host-blocks-webassembly) | Keep editing when the host blocks WebAssembly | story | S | must |
| [WASM-004](WASM-rust-kernels.md#wasm-004-a-layout-worker-that-hosts-the-kernel) | A layout worker that hosts the kernel | enabler | M | must |
| [WASM-005](WASM-rust-kernels.md#wasm-005-font-faces-from-the-manifest-inside-the-kernel) | Font faces from the manifest inside the kernel | enabler | M | must |
| [WASM-006](WASM-rust-kernels.md#wasm-006-shaping-and-measurement-behind-the-measurement-interface) | Shaping and measurement behind the measurement interface | enabler | M | must |
| [WASM-007](WASM-rust-kernels.md#wasm-007-unicode-segmentation-in-the-kernel) | Unicode segmentation in the kernel | enabler | M | must |
| [WASM-008](WASM-rust-kernels.md#wasm-008-first-fit-line-breaking-in-the-kernel) | First-fit line breaking in the kernel | enabler | M | must |
| [WASM-010](WASM-rust-kernels.md#wasm-010-the-kernel-in-nodejs-for-tests) | The kernel in Node.js for tests | enabler | S | must |
| [WASM-011](WASM-rust-kernels.md#wasm-011-identical-results-in-every-browser) | Identical results in every browser | enabler | M | must |
| [WASM-012](WASM-rust-kernels.md#wasm-012-size-memory-and-time-budgets-for-the-kernel) | Size, memory and time budgets for the kernel | enabler | S | must |
| [WASM-013](WASM-rust-kernels.md#wasm-013-rust-supply-chain-and-licences) | Rust supply chain and licences | enabler | S | must |
| [PRO-129](PRO-protocol.md#pro-129-freeze-protocol-10-after-a-second-server-passes-core) | Freeze protocol 1.0 after a second server passes `core` | story | M | should |
| [BE-083](BE-backend.md#be-083-state-the-recovery-point-of-self-hosted-deployments) | State the recovery point of self-hosted deployments | story | S | should |
| [BE-095](BE-backend.md#be-095-upgrade-self-hosted-deployments-across-one-skipped-minor-version) | Upgrade self-hosted deployments across one skipped minor version | enabler | M | should |
| [BE-097](BE-backend.md#be-097-define-the-on-call-process-for-hosted-mode) | Define the on-call process for hosted mode | decision | S | should |
| [SEC-061](SEC-security.md#sec-061-decide-the-abuse-handling-policy-for-hosted-mode) | Decide the abuse-handling policy for hosted mode | decision | S | should |
| [FRW-064](FRW-fields-rules-workflow.md#frw-064-neutralise-spreadsheet-formula-characters-in-field-exports) | Neutralise spreadsheet formula characters in field exports | story | S | should |
| [WASM-009](WASM-rust-kernels.md#wasm-009-hyphenation-with-tex-patterns) | Hyphenation with TeX patterns | enabler | M | should |
| [WASM-015](WASM-rust-kernels.md#wasm-015-bidirectional-text-and-complex-script-shaping-in-the-kernel) | Bidirectional text and complex-script shaping in the kernel | enabler | L | should |
| [SYN-042](SYN-sync-engine.md#syn-042-attach-viewers-to-follower-nodes-that-never-submit) | Attach viewers to follower nodes that never submit | enabler | M | could |
| [PRO-007](PRO-protocol.md#pro-007-signal-deprecations) | Signal deprecations | enabler | S | could |
| [PRO-020](PRO-protocol.md#pro-020-reserve-a-binary-frame-layout-for-engines-with-opaque-payloads) | Reserve a binary frame layout for engines with opaque payloads | enabler | S | could |
| [PRO-128](PRO-protocol.md#pro-128-decide-when-to-build-a-second-server-implementation) | Decide when to build a second server implementation | decision | S | could |
| [BE-028](BE-backend.md#be-028-attach-large-audiences-to-follower-nodes) | Attach large audiences to follower nodes | enabler | L | could |
| [BE-068](BE-backend.md#be-068-run-gateway-room-and-api-tiers-as-separate-deployables) | Run gateway, room and API tiers as separate deployables | enabler | L | could |
| [BE-069](BE-backend.md#be-069-design-the-placement-service) | Design the placement service | spike | M | could |
| [BE-070](BE-backend.md#be-070-shard-postgresql-by-tenant) | Shard PostgreSQL by tenant | enabler | L | could |
| [BE-071](BE-backend.md#be-071-evaluate-moving-the-commit-log-to-a-log-store) | Evaluate moving the commit log to a log store | spike | M | could |
| [BE-072](BE-backend.md#be-072-use-a-managed-queue) | Use a managed queue | enabler | M | could |
| [BE-073](BE-backend.md#be-073-run-a-hot-document-in-a-dedicated-process) | Run a hot document in a dedicated process | enabler | M | could |
| [BE-074](BE-backend.md#be-074-assign-a-home-region-and-forward-channels-to-it) | Assign a home region and forward channels to it | enabler | L | could |
| [BE-075](BE-backend.md#be-075-cache-version-pinned-content-and-assets-near-users) | Cache version-pinned content and assets near users | enabler | M | could |
| [BE-093](BE-backend.md#be-093-run-a-dedicated-deployment-for-one-tenant) | Run a dedicated deployment for one tenant | enabler | M | could |
| [SEC-055](SEC-security.md#sec-055-review-sandboxed-third-party-extensions) | Review sandboxed third-party extensions | enabler | L | could |
| [SEC-058](SEC-security.md#sec-058-prove-data-stays-in-the-tenants-home-region) | Prove data stays in the tenant's home region | enabler | M | could |
| [FE-112](FE-frontend.md#fe-112-plan-bidirectional-complex-script-and-east-asian-layout-for-the-page-view) | Plan bidirectional, complex-script and East Asian layout for the page view | spike | M | could |
| [UX-060](UX-experience.md#ux-060-run-extensions-in-a-sandboxed-iframe) | Run extensions in a sandboxed iframe | story | L | could |
| [EXP-063](EXP-export.md#exp-063-start-engines-ahead-of-time-in-fresh-sandboxes) | Start engines ahead of time in fresh sandboxes | enabler | M | could |
| [WASM-014](WASM-rust-kernels.md#wasm-014-contributor-guide-for-the-kernel) | Contributor guide for the kernel | enabler | S | could |
| [WASM-016](WASM-rust-kernels.md#wasm-016-line-breaking-rules-for-east-asian-and-south-east-asian-scripts) | Line-breaking rules for East Asian and South-East Asian scripts | enabler | M | could |

