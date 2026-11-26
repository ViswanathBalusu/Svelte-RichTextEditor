# 0361. Lane w4, SPK-011: the first jurisdictions and the sealing party

**Status:** answered by the owner (2026-11-15, decisions 13 and 14 of `docs/owner-decisions-2026-11-15.md`: the European Union and the United States from the start; the operator seals by default, and a tenant's own key and certificate are used where supplied). The text below is the proposal as written (2026-11-15). Written by the developer of lane w4 for SPK-011. Not reviewed by the owner. Nothing here is an owner decision: it sets out the question, the default the spec already has, and a working assumption for the stories that wait on the answer.

## Context

Owner decision 11 of 11 §10 and question 2 of 12 §15 ask two things:

1. Which jurisdictions come first, and is a simple electronic signature with a seal enough at launch?
2. Who is the sealing party: the operator, or each tenant?

The spec's default is "undecided; simple electronic signature plus seal at launch" (11 §10). ADR 0013 (proposed) and 12 §8.3 describe the native offer as a simple electronic signature with an audit trail and a tamper-evident seal "applied by the operator (or by the tenant's own key)". The legal note (SPK-024, `docs/research/2026-11-06-legal-note.md` §5.4) says the seal belongs to a legal person, the operator or each tenant, and leaves the choice here. It also says that nothing can be said about a jurisdiction until it is chosen and reviewed by counsel (§5.2).

What waits on the answer:

- spike S8 (SPK-021), which needs a key and a certificate to seal a sample;
- the FRW sealing stories that the FRW epic lists against this question (FRW-052, FRW-053, FRW-058, FRW-087);
- counsel's review (FRW-087), which is made against named jurisdictions.

The owner's decisions on the first market (SPK-006: all three candidate markets) and on hosting (SPK-008) do not name a jurisdiction or a sealing party, and PRODUCT.md still lists both as undecided.

## The options

### Jurisdictions

The spec names two legal frameworks because its design was checked against them: eIDAS in the European Union, and ESIGN and UETA in the United States (12 §8.3, ADR 0013). The legal note read the United Kingdom's retained copy of eIDAS. No other jurisdiction has been looked at. The choices the owner has are therefore:

| Option | What it means for the work |
|---|---|
| J1: the European Union first | Counsel reviews against the current eIDAS text and the form rules of the member states the owner names. The seal and the time-stamp are described without "qualified" unless the certificate and the authority are qualified |
| J2: the United States first | Counsel reviews against ESIGN, the UETA as enacted in the states the owner names, and the consumer-consent rule the legal note did not re-read |
| J3: both, or others | More review before sealing is announced for production use (FRW-087). Any jurisdiction outside the two frameworks starts from nothing |

This record does not recommend one. The choice depends on where the first customers are, which only the owner knows.

### Sealing party

| Option | Key and certificate arrangement | Consequences |
|---|---|---|
| P1: the operator seals | One sealing key per deployment in the operator's key service, with a certificate issued to the operator. The signing service uses it for every tenant | Simplest to run. The sealed PDF names the operator, not the tenant. In a self-hosted deployment the operator is the organisation that runs it |
| P2: each tenant seals | One key per tenant, in the operator's key service or in the tenant's own, with a certificate issued to the tenant. The signing service chooses the key by tenant | The sealed PDF names the tenant. Each tenant must obtain a certificate and renew it; onboarding, expiry and revocation become per-tenant work |
| P3: the operator by default, a tenant's own key where the tenant supplies one | Both arrangements; the tenant's key overrides the operator's | Matches the wording of 12 §8.3 and the legal note. The signing service and the evidence record must carry which party sealed |

## Proposal

Until the owner decides:

1. **The default stands.** The jurisdictions are undecided, and the launch offer is a simple electronic signature with a seal (11 §10). No product text names a jurisdiction.
2. **Working assumption for design only: P3.** Stories that need an arrangement to design against (SPK-021, FRW-052, FRW-053) assume a sealing key chosen per tenant, with the operator's key as the fallback. A design made for P3 also serves P1 (no tenant keys configured) and P2 (no operator key configured), so the owner's choice removes a case and does not add one. This is the reading the spec's own sentence in 12 §8.3 already has; it is not a new decision.
3. **Nothing is announced.** Sealing and certificates are not announced for production use until counsel's review against the chosen jurisdictions is recorded (FRW-087, legal note §5.6).

## What the owner is asked

- Name the first jurisdictions (J1, J2, J3 or others).
- Say whether a simple electronic signature with a seal is enough at launch in them.
- Choose the sealing party (P1, P2 or P3).

When the owner answers, PRODUCT.md records the jurisdictions and the sealing party, its "Undecided" line loses the item, 11 §10 item 11 and 12 §15 item 2 are marked decided, and SPK-021 and the FRW sealing stories are checked against the chosen arrangement.

## Consequences

- SPK-011 stays open: each of its criteria needs the owner's word.
- SPK-021 can design its key handling against the working assumption, but it cannot obtain the right party's certificate until the party is chosen.
- If the owner chooses P1 or P2, the unused half of P3 is removed from the designs that assumed it.
