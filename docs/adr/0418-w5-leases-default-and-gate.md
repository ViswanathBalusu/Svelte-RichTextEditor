# ADR 0418: `leases` on by default, a gate on the lease routes, and the check-out control (lane w5)

Status: proposed. Owner decisions are the owner's; each item names the spec default used.

Date: 2026-11-18.

## Context

PRM-043 criteria 6 (second clause) and 7 waited for three things: `leases` in the features the
reference service announces (owner decision 190 says comments, history and leases are on by
default), a way to switch it off, and a check-out control in the component. The lane w9 notes of
2026-11-17 and 2026-11-18 said no decision named the control or what the service refuses when
`leases` is off. The brief of lane w5 gives the direction; the choices below fill what it leaves.

## Decisions taken in the lane

1. **`leases` joins the protocol features of the reference service.** `PROTOCOL_FEATURES` in
   `services/document-service/src/data-plane/settings.ts` lists it, so discovery, `welcome` and the
   data plane's `ch.open` check announce it together (05 §1 rule 4). Comments and history are
   decision 190's other two; they belong to other lanes and are not changed here.

2. **The lease routes are gated on the announced feature.** With `leases` missing from the list
   (`DOCEDIT_FEATURES`), `POST`, `PUT` and `DELETE /documents/{id}/regions/{rid}/lease` answer
   `not_found` ("this server does not announce the leases feature"). 05 names no code for it;
   `not_found` is what a route the server does not offer already answers (as the mock and relay
   targets do). Proposed default: as above. The gate is in `lease-routes.ts` only; no other route
   reads a feature, so this starts no general pattern. A service credential is refused too, because
   the route does not exist without the feature.

3. **The check-out control is part of the permissions pane.** The pane lists the regions and who
   may edit them (13 §3; PRM-032), and a lease is a statement about who may edit one. For the
   selected region it shows one of: a "Check out" button (the user can edit the region and nobody
   holds it), the holder's name (someone else holds it, no button), "Release" (the user's own
   lease), or the reason it cannot be offered (approved region, no `edit`). It shows none of this
   when the core has no leases service. Breaking another user's lease (PRM-045) is not offered
   here. Proposed default: the pane, not a toolbar command, because a toolbar command needs a
   region to act on and the pane already selects one.

4. **The core gets a `leases` service only for a backend that announces the feature and has the
   port** (`packages/element/src/lease-shell.ts`, `leasesFor`; 05 §8.3: the interface shows a
   feature only when its port is present). The element asks for `leases` in `hello`
   (`backend-source.ts`); it is negotiated only where the server announces it.

5. **"Mine" is a lease this session took and the region list still shows with the same holder.**
   The service keeps the leases the session acquired. The pane treats a region as the user's when
   the list's `leasedTo` equals the holder of one of them, so a lease that lapsed and was taken by
   someone else is shown as theirs.

## Open questions for the owner

- Whether a lease that lapses or is broken should tell the holder in words (PRM-044, PRM-045).
- Whether the check-out belongs also in the context menu of a locked region.
- Whether the `not_found` of decision 2 should be another code (for example `forbidden`), in 05 §5.8.
