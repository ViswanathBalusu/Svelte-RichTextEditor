# ADR 0392: The authority service as a container (proposed)

Status: proposed. Lane w5, story BE-007. The maintainers have not accepted it. Owner decision 96
(2026-11-15, [owner decisions](../owner-decisions-2026-11-15.md)) starts the production backend now,
alongside the rest; the Node.js service stays the reference. The service is the one of ADR 0389 and
ADR 0391.

## Context

05 §10 says the service "can rebuild any of them from storage, so it holds no state that matters". It
does not say how the service reaches that storage. BE-007 needs a replica that is asked about a
`stateId` it does not hold to rebuild it instead of failing.

## Choices

1. Storage is the caller's. The service calls one route of the caller,
   `GET {DOCEDIT_AUTHORITY_STORAGE_URL}/states/{stateId}`, and gets the inputs of `open` for that
   state (`doc`, `checkpointRef`, `commits`, `stateId`), or `404`. The service then verifies the
   answer exactly as it verifies an `open` call (chain, head, checkpoint; ADR 0389), so a wrong or
   tampered answer is refused (`chain_broken`, `state_mismatch`) and never held. A storage that
   cannot be reached is `storage_unavailable` (503). Without a storage URL the service answers
   `unknown_state` and the caller calls `open`, as before.
2. The interface has no login of its own. `DOCEDIT_AUTHORITY_TOKEN`, when set, is a bearer token that
   every call but `/health` and `/ready` must carry. The service is server to server and belongs on a
   private network; the token is a second guard, not a replacement for one. The storage token is
   separate (`DOCEDIT_AUTHORITY_STORAGE_TOKEN`). Neither is written into a file or an image.
3. The image holds the service and the five packages it reads, with production dependencies only, and
   runs as `node` with a read-only root file system and no capabilities. It binds `127.0.0.1` unless
   `DOCEDIT_AUTHORITY_HOST` says otherwise. The base image is the one `packages/tck/Containerfile`
   pins.
4. `services/authority-service/compose.json` is the compose entry. It uses host networking and
   loopback, like `infra/containers/compose.json`, for the WSL Podman machine. There is no Helm
   entry: the chart of BE-006 does not exist. When it does, it takes the same environment variables,
   with the tokens from a secret.
5. The container test (`test/container.test.ts`, off unless `DOCEDIT_AUTHORITY_CONTAINER=1`) starts the
   service from the options of `compose.json` with `podman run`, because this machine has no Compose
   provider.

## Consequences

- The backend must serve the storage route for a replica to rebuild. A backend that does not simply
  gets `unknown_state` from a replica that lacks the state, and calls `open`.
- `applyCommit` (PRO-104) is not built, so "the next `applyCommit` returns the same result" (BE-007
  criterion 2) cannot be shown yet.

## Addendum, 2026-11-21 (lane w5; proposed like the rest)

`applyCommit` is built (PRO-104), and so is the kit's profile (PRO-125). Two readings were needed to
run BE-007 criteria 2 and 4 against a real container. Neither is decided here.

6. "The same result" of criterion 2 is the body of the answer, byte for byte: the mapped steps, the
   scopes, the commits to store and the new `stateId` for an accepted commit, and the rejection for
   a refused one. The request therefore carries its `commit.time`: the service would otherwise take
   its own clock, the time is part of the hash chain, and the second answer would name another
   state. A caller that wants a repeatable answer sends the time.
7. "The deployed container" of criterion 4 is the image run with the options of `compose.json` by
   `podman run`, as in choice 5. The kit's profile is given the container's address and nothing
   else, and its restart scenario kills the container (SIGKILL) and starts it again. Whether a start
   by Compose or by the chart is also needed before criterion 4 counts is not asked by the
   criterion; criterion 1 asks for it and stays open.

One thing seen on the way: Podman builds the image in the OCI format, which drops the
`HEALTHCHECK` of the Containerfile with a warning. The compose entry carries its own health check,
so a start by Compose is not affected; a bare `podman run` has none.
