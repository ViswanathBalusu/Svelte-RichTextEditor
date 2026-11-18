# ADR 0413: Test-mode timers of the reference service (PRO-109)

Status: proposed, resting on owner decision 191 (docs/owner-decisions-2026-11-15.md: "60 s, with a
guard against production use and a security review of the switch") and on decisions 196 to 220
(proposed defaults accepted). Lane w5, story PRO-109.

## Context

05 §11 gives the conformance kit a test-mode switch that shortens timers. The story asks that the
switch off leaves every timer at its specified value, that the switch on shortens them, and that
the kit's waits end quickly. Earlier lanes left three points open: the specified values of the job
lease, node lease and outbox poll; a region lease route to shorten; and "within seconds" against a
60 second token lifetime.

## Decisions

1. **Token lifetime in test mode is 60 seconds** (owner decision 191), never above 15 minutes
   (05 §3.1). Criterion 3 is reworded: a token expires after the test-mode lifetime plus the 60
   seconds of clock skew the verifiers allow (05 §3.1), so the last accepted use is two minutes
   after minting. The skew is not removed in test mode; ADR 0042 item 9 proposed that and the owner
   did not take it up.
2. **The specified values of the timers 05 and 06 leave without one are the documented defaults of
   the service**, so that criterion 1 has something to check (proposed; decisions 196 to 220 accept
   proposed defaults):

   | Timer | Default, switch off | Test mode | Where |
   |---|---|---|---|
   | Job lease | 30 s | 2 s | ADR 0036; `config.ts` |
   | Node lease | 15 s, renewed every 3 s | 3 s | `data-plane/settings.ts` |
   | Outbox poll | 1 s (lease 30 s) | not shortened | `data-plane/settings.ts` |
   | Region lease | 5 minutes per acquisition or heartbeat, 8 hours in all | 3 s per acquisition or heartbeat | 07 §10; `LEASE_DEFAULTS` |

   The outbox poll is already a second, so test mode leaves it alone.
3. **The region lease is shortened by test mode.** The service has the lease routes now
   (PRO-053). `TEST_TIMERS.regionLeaseMs` is 3 seconds and the lease routes pass it to
   `acquireLease` and `renewLease` as `options.durationMs`. The eight-hour maximum is not changed.
   With the switch off the routes pass no option and the 07 §10 values hold.
4. **The guard against production use** exists: `configFromEnv` refuses test mode when
   `DOCEDIT_ENVIRONMENT` is `production`, which is the default (BE-079 criterion 1), and discovery
   reveals nothing a client could use to turn the switch on (`pro-109-discovery.test.ts`).
5. **The security review of the switch** is the owner's decision 191 and is a human review. It is not
   done here and is not claimed.

## Not decided here

- Whether test mode should drop the 60 second clock skew on token expiry (ADR 0042 item 9).
- The value of the region lease in test mode (3 seconds is a choice, like the other shortened
  timers in `TEST_TIMERS`; no measurement stands behind it).
