# DEP conformance kit

The kit certifies a DEP backend from the outside. It needs three inputs and nothing else
(05 §11; PRO-108):

- a discovery URL (`/.well-known/dep`);
- a service credential, read from the environment (`DEP_TCK_CREDENTIAL`), never from the command line;
- the test-mode switch of the server, which shortens timers such as token lifetime and lease expiry.

An optional fourth input turns on more checks: a service credential of a second tenant
(`DEP_TCK_OTHER_CREDENTIAL`). With it the `authz.other-tenant` scenario shows that a caller of another
tenant sees, changes and opens nothing of the kit's tenant (documents, holds, webhooks, keys, origins,
audit); without it the scenario is skipped with that reason (UX-076).

The kit mints its own user tokens through `POST /tokens`, registers a webhook that points at itself
and creates its own documents.

## Run it

Build the image from the repository root with Podman (never Docker):

```sh
podman build -f packages/tck/Containerfile --ignorefile packages/tck/Containerfile.ignore -t docedit-tck .
```

Run it against a server:

```sh
podman run --rm -e DEP_TCK_CREDENTIAL="$CREDENTIAL" -v "$PWD/out:/out" docedit-tck \
  --discovery https://docs.example.com --json /out/report.json --text /out/report.txt
```

Exit code 0 when the run passes, 1 when it fails, 2 on a usage error.

To certify an authority service (05 §10) instead, give its address; a bearer token, when it needs
one, goes in `DEP_TCK_AUTHORITY_TOKEN`:

```sh
podman run --rm -e DEP_TCK_AUTHORITY_TOKEN="$TOKEN" docedit-tck \
  --authority-service http://authority.internal:8090 --profile authority-service
```

## Which profiles apply

A profile applies when the server announces what it maps to: a mode (`authority` or `relay`) or
one or more feature names (05 §11: "a profile maps to the features a server may announce"). A
profile whose requirement the server does not meet is reported as skipped, with the reason.

| Profile | Applies to | Notes |
|---|---|---|
| `core` | mode `authority` | Discovery, authentication, framing, channels, sync and the REST conventions. |
| `semantics` | mode `authority` | Step semantics and the conversation of 05 §5.9. |
| `presence` | feature `presence` | Presence messages (05 §5.4). |
| `perm-doc` | mode `authority` | Document-level permissions. |
| `perm-region` | feature `regions` | Region-level permissions. |
| `perm-read` | feature not yet named | Read restrictions (ADR 0019). The feature name is the kit's proposal `read-restrictions` until PRO-130 names one (ADR 0042 item 4); the profile is skipped until a server announces it. |
| `exports` | feature `exports` | Export jobs. |
| `assets` | feature `assets` | Asset jobs. |
| `authz` | mode `authority` | Every row of the authorisation matrix (07 §12). |
| `registry` | mode `authority` | Every rejection code of the error registry (05 §5.8). |
| `fuzz` | mode `authority` | Fuzzing of the envelope parser and of step validation. |
| `fields` | feature `fields` | Fillable fields (12 §4). |
| `perm-fill` | feature `fields` | Fill permissions (12): a property test of a participant minted with the `wfr` roles claim (FRW-066). |
| `rules` | features `rules`, `fields` | The rules fixtures (12 §5; FRW-020): each `rules` case of the published set is one scenario named by the fixture identifier, judged through fills and saves over DEP. Cases that need the server clock, formula values or messages are judged by `authority-service` (`evaluate-rules`). |
| `core-relay` | mode `relay` | Relays only (05 §9). One scenario: discovery says `relay` and announces none of `regions`, `suggest-enforced`, `fields` (PRO-124). The scenarios that submit commits to a relay (`stale_base` on a base that is not the head; commits at the head stored and relayed unchanged) wait for a relay server that speaks DEP. |
| `perm-suggest` | feature `suggest-enforced` | Suggestion-only rule (07 §5.2); built (PRO-118), run against the mock backend. Scope: `ins`, `del` and `fmt` marks on text in a paragraph; block-level suggestions (paragraphs, whole table rows, whole tables) are tested in `packages/authority`, not in the profile (PRM-062). |
| `history` | feature `history` | History, versions, comparison, attribution, restore; not yet built (PRO-119). |
| `comments` | feature `comments` | Threads and comments; not yet built (PRO-120), except the rule that a thread or a comment is refused to a caller of another document (PRO-045). |
| `reactions` | feature `reactions` | Reactions to comments (13 §5; ADR 0424). One scenario: a reaction is refused to a caller whose token covers another document (PRO-045). |
| `webhooks` | always; each scenario is skipped when `GET /webhooks` is `not_found` | Signed webhooks (05 §7), built (PRO-121). DEP names no feature for webhooks (ADR 0416, proposed). The kit runs a receiver (`--receiver-host`, `--receiver-port`, `--receiver-url`) and registers it with `POST /webhooks`; the target refuses private and loopback addresses (10 §3.2), so the receiver needs a public name, or the server runs in test mode with the receiver's address in `DOCEDIT_TEST_WEBHOOK_ALLOW`. Five scenarios: the CloudEvents body against the schema of the event; the Standard Webhooks signature, the five-minute tolerance, and a changed body, an old timestamp and a wrong secret refused; a rotation (both secrets, then the new one alone); a delivery answered 500 arrives again under the same `webhook-id`; and 100 commits make at most one `dep.document.changed.v1` per ten seconds. |
| `leases` | feature `leases` | Exclusive-edit leases (07 §10). Five scenarios: who may take a lease and who may break one (PRM-058); while a lease is held another user's commit in the region is refused with `permission_denied` and `perm.changed` lists the lease; a holder that sends no heartbeat loses the lease when the shortened expiry of test mode passes (the value is read from `GET /_test/timers`; skipped without the test-mode switch), and `perm.changed` says so; a user with `manage` who breaks a lease ends it at once (PRO-122). |
| `authority-service` | an address given with `--authority-service` | The authority service interface (05 §10), over its HTTP binding (ADR 0314). It is not reached over DEP, so the run needs the service's address and, when the service has one, its bearer token in `DEP_TCK_AUTHORITY_TOKEN`. The profile runs the calls, the step-semantics, canonical-hash and rules fixtures through the service, and a restart between calls when the caller can restart the service (a library caller gives `authorityService.restart`; the command line cannot). `mapRanges` is run through `POST /v1/authority/states/{stateId}/map-ranges` (PRO-105): ranges mapped from several seqs, a collapsed range, a presence position, and the refusals. A run may name no discovery URL; every DEP profile is then skipped. Built (PRO-125). |
| `fault-injection` | feature `test-hooks` | Durability before acknowledgement, fencing, log rewind and the grants revision, through test hooks (PRO-126). A server announces `test-hooks` only while its test-mode switch is on (ADR 0219, ADR 0398). Six scenarios: a failed write is never acknowledged and an acknowledged commit survives a killed room; a fenced room closes its channels `unavailable` and no commit is stored twice; a rewound log gives `catchUp: "reload"` for the new incarnation (a server whose store cannot be rewound skips it); a lost grants announcement never lets a commit be stored under the old grants; a rolling restart (`POST /_test/restart-node`) sends `goaway` and closes with 4503, and a client that follows the hint loses no acknowledged commit (PRO-024); an idempotency key repeated within the retention time returns the first document, and one used after it creates a new document, with the retention read from GET /_test/timers (PRO-043). The hook routes are the reference service's own (ADR 0398). Skipped without the hooks. |

## Implementation order

Build a server in this order. The order is the spec default: 05 §11 says the kit grows with the
roadmap, with the `core` scenarios first. The order after `core` is a proposal recorded in
`docs/adr/0220-lane-PRO-127-131.md` and is not yet an owner decision.

1. `core`. Nothing else can be checked until discovery, authentication, channels and sync work.
2. The mode profiles that need nothing else: `semantics`, `perm-doc`, `authz`, `registry`, `fuzz`.
3. The feature profiles for the features the server announces, in the order of 05 §11: `presence`,
   `perm-region`, `exports`, `assets`, `fields`, `perm-fill`, `rules`, `perm-read`, `perm-suggest`.
4. The profiles of the phase 2 features, when the server implements them: `history`, `comments`,
   `webhooks`, `leases`.
5. `authority-service` and `core-relay`, when the server is a second kind of backend.

A profile is reported as passed only when every announced scenario passes. A scenario that needs a
fault, a load or a server hook is skipped with the reason written in the report.

## What the kit cannot see

Durability before acknowledgement, fencing, the hash chain and the audit trail are not observable
from outside. The optional fault-injection profile (PRO-126) covers them for servers that expose the
test hooks. A server without the hooks is reported with that profile skipped, so the report states
what is not proven.
