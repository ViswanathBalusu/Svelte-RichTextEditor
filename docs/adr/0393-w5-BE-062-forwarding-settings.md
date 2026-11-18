# ADR 0393: Settings and choices of channel forwarding (BE-062)

Status: proposed. Written by lane w5, 2026-11-18. The spec names no figure for any setting below; the
values are the defaults of `services/document-service/src/data-plane/forwarding.ts` and are not
measured. Owner decisions 136 (the bus is Valkey streams) and 200 (the address of a node is on its
lease row, falling back to rendezvous routing) are applied as given
([owner decisions](../owner-decisions-2026-11-15.md)).

## Context

BE-062 forwards a channel that lands on a node other than its document's owner. The stream core
(`control-plane/channel-forward.ts`) existed; this lane joined it to the session, the room host and
the bus (`data-plane/bus.ts`, `valkey-bus.ts`).

## Choices

1. **Where the gateway decides.** In `Session.#openChannel`, after the token, the rate limits and
   the quotas, and before `host.acquire`. A document whose head names another node with a live lease
   is forwarded to it. A document with no live owner is forwarded to the host that rendezvous
   routing names over the live leases, unless that host is this node. The owner then claims the
   document through the epoch check of BE-017; the decision grants nothing. Proposed.
2. **One inbox stream per node, two ordered streams per channel.** Frames of every channel for a node
   share the Valkey stream `node:<name>`. Each channel numbers its own frames in each direction
   (up and down) and repairs gaps itself. Proposed.
3. **A silent peer ends the channel.** Each end announces the head of its stream every
   `heartbeatMs` and closes after `silenceMs` without hearing the other. Without this a channel
   whose bus went away would stay open and silent. Proposed.
4. **The owner of a forwarded document is watched.** The gateway reads the document head and the
   owner's lease every `ownerWatchMs` for each forwarded document and closes the channels when the
   owner changed or its lease ended (`unavailable`, `retryInMs`). Proposed.
5. **Announcements are hints to read again.** A change of grants, of a document or of a workflow is
   announced on the topic `announce` as the document and nothing else; the receiving node reads the
   state from storage (`data-plane/announcements.ts`). Proposed.
6. **The bus is built from `DOCEDIT_VALKEY_URL`.** With that variable and node leases the service
   opens a Valkey streams bus itself (`server.ts`); a test passes its own. A node address is given
   by `DOCEDIT_NODE_ADDRESS`. Proposed.

## Settings (defaults; none measured)

| Setting | Default | Meaning |
|---|---|---|
| `retain` | 2000 | frames each stream keeps for repair |
| `repairMs` | 200 | wait before a gap is asked for again |
| `maxNacks` | 10 | requests for one frame before the gap is unrepairable |
| `retryInMs` | 1000 | the `retryInMs` a client gets when a forwarded channel closes |
| `heartbeatMs` | 250 | how often each end announces the head of its stream |
| `silenceMs` | 3000 | silence after which a channel closes |
| `openTimeoutMs` | 5000 | how long the gateway waits for the owner to answer `ch.open` |
| `ownerWatchMs` | 500 | how often the owner of a forwarded document is checked |

## Consequences

- A heartbeat is one bus message per channel and direction every `heartbeatMs`. Its cost at many
  channels has not been measured; BE-066 (the stage 2 run) should read it, and a heartbeat per node
  pair would replace it if it is too high.
- The Valkey bus has one reader connection per node. A message published while the reader cannot
  reach Valkey is read when it can, if the stream still holds it.
