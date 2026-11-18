# ADR 0402: A node dedicated to one hot document (BE-073)

Status: proposed (2026-11-18, lane w5). Not decided by the owner. Each choice below is the narrowest one that meets the story and 06 §6, §8; it is open for review.

## Context

06 §8 lists a dedicated process as the last answer to a hot document, after coalesced broadcasts and followers for viewers. 06 §6 names it as stage 3 compute. The service already routes a document to one room host by rendezvous hashing over the live nodes (BE-060), tells clients where it is (BE-061), forwards a channel that lands elsewhere (BE-062), and lets the epoch check decide ownership (BE-017, BE-018).

## Decisions taken in the code

1. **A dedicated process is an ordinary node with one trait.** It runs the same service, takes the same lease, and claims its room through the same epoch check as any owner. What marks it is `dedicated` on its lease row (`DOCEDIT_DEDICATED_DOCUMENT`, migration 0091, `NodeTraits`). The story's criterion 3 therefore holds by construction, and the test reads the epoch before and after.
2. **"Marked hot" is "a dedicated node is live for it".** There is no separate flag, table or threshold. An operator (or the orchestrator of BE-068) starts the process for the document. This avoids inventing a rule for when a document counts as hot; the spec gives none and no figure was measured. Who decides, and by what measure, is open question 1.
3. **Routing (`eligibleHosts`, `room-routing.ts`).** A live host dedicated to the document is the only candidate for it. A host dedicated to another document is never a candidate. General hosts are candidates for everything else, as before. The same rule is used by the forwarder (`Forwarder.route`) and by the connect hint (`Placement.route`).
4. **A dedicated node serves nothing else.** A channel that lands on it for another document is forwarded to a general node by the same route. This needs the bus (BE-062); a dedicated node without a bus would serve what it is given. The composition must give a dedicated node the bus.
5. **Fallback while the dedicated node is down.** When no dedicated node is live for the document, the general nodes are candidates again, so the document stays available at the cost of its isolation. The other choice (refuse until the dedicated node returns) is open question 2.
6. **A room that is already open stays where it is.** Routing never moves an owner (BE-060 criterion 3). A document that was open on a general node when its dedicated node started moves when that room closes (idle release, BE-021) or its lease ends. Until then a channel that lands elsewhere is forwarded to the current owner. A faster hand-off needs the owner to close the room, which the story does not ask for.

## Not decided here

- Whether the process is pinned to a core. That is the orchestrator's job (a CPU request and a limit of the container, or an affinity setting of the host); the service cannot pin itself portably, and no figure of it was measured.

## Open questions for the owner

1. Who marks a document hot, and by what measure (an operator action, or a rule on the room's event-loop use)? 06 §8 says only "one room saturates a core".
2. While a hot document's dedicated node is down: serve it on a general node (as built), or refuse?
3. Is a dedicated node for several hot documents ever wanted? The trait names one document, as the story does.
