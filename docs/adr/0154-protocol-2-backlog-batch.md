# ADR 0154: protocol-2 backlog batch (PRO-100 to PRO-129)

**Status:** proposed. **Date:** 2026-11-13. **Lane:** protocol-2, round 1.

## Context

The lane was asked to take three to five unclaimed stories from the end of PRO-protocol's slice (PRO-129 backwards) whose criteria can be met inside `packages/protocol`. Each story was read against its Evidence and Notes, and against the code that exists today.

## Finding

Corrected on 2026-11-13 (fix round 1). The first version of this record said that every story in PRO-100 to PRO-129 with open criteria is a kit profile, a kit publication task or a decision. That was wrong: PRO-101 to PRO-111, PRO-114 and PRO-116 also have open criteria and were not discussed. Each story with open criteria, and where its work lives:

- PRO-100 (local IndexedDB backend): `packages/backend-local` and the element. Nothing in `packages/protocol`.
- PRO-101 (what each tier may announce): criterion 3 has a protocol part. The definition already marks `regions`, `suggest-enforced` and `fields` as `relayForbidden` (`src/definition/features.ts`), but nothing checked an announcement against it. This round adds the check (see Decision). The rest of criterion 3 (the kit runs `core-relay` instead of `core`) is PRO-124 in `packages/tck`, so the criterion stays open. Criterion 4 is the kit's profile selection (`packages/tck/src/runner.ts`). Criteria 1 and 2 need the step-semantics fixtures run by a native backend and the authority service (PRO-125); criterion 5 is the integration guide (SYN-044). None of them can be met in `packages/protocol`.
- PRO-102 (wire binding of the authority service): a spike whose output is a written recommendation and a measured prototype. No protocol code.
- PRO-103 to PRO-107 (authority service calls): the service does not exist, and the binding is PRO-102's open decision. A protocol type for the calls would be a guess at a binding not yet chosen.
- PRO-108 criterion 2 (webhook self-registration), PRO-110 criterion 5 (the kit replays the fixtures), PRO-111 criteria 3, 4 and 6 (channel, sync and reference-service runs), PRO-114 criteria 1 and 3 (assets profile runs), PRO-116 criterion 4 (the one-hour fuzz run): all are runs of `packages/tck` against a server.
- PRO-109 (test-mode switch): the switch is the server's (control plane); the kit side is already built.
- PRO-118 to PRO-126 (profiles `perm-suggest`, `history`, `comments`, `webhooks`, `leases`, rules fixtures, `core-relay`, `authority-service`, fault injection): `packages/tck`.
- PRO-127 (publish the kit): the image and the release notes of `packages/tck`.
- PRO-128 and PRO-129: a decision by the owner and a later freeze; not a code task.

## Decision (proposed)

1. A client refuses a discovery document whose `mode` is `relay` and whose `features` hold a name the definition marks `relayForbidden` (05 §2: "a relay never announces `regions`, `suggest-enforced` or `fields`"). `checkDiscovery` in `packages/protocol/src/client/negotiate.ts` returns `unsupported_feature` with the names; `backend-dep` already turns a non-null result of `checkDiscovery` into a refusal before it connects. 05 does not say what a client does with such a document; refusing is chosen over ignoring the names, because a client that used them would trust enforcement the server does not do. The owner or the main session may choose to ignore the names instead; the change is one line.
2. Assign the open criteria of PRO-118 to PRO-127, and the kit halves of PRO-101 criteria 3 and 4, to a lane whose directory is `packages/tck`.
3. PRO-128: the decision on a second server implementation is the owner's. Per the story's own condition, the default is "not scheduled" until a partner asks. Not decided here.

## Consequences

`relayForbiddenAnnounced` and the extra check in `checkDiscovery` are tested in `packages/protocol/src/client/negotiate.universal.test.ts` (each forbidden name, an authority announcing all three, and a fast-check property over every subset of the registered names). No criterion is ticked: PRO-101 criterion 3 also needs the `core-relay` profile.
