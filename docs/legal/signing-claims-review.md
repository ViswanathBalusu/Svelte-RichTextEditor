# Legal review of the signing claims (FRW-087)

**Outcome status: no review has taken place.** This record is the place for counsel's written outcome. Until the outcome is recorded below, the sealing and certificate features are not announced as available for production use, and nothing in the repository says counsel has reviewed them. The absence of a review is also stated in `PRODUCT.md` (evidence on hand). It is not filled with assurance that does not exist.

Last updated: 2026-11-18 (lane w4).

## What the owner has settled

These come from `docs/owner-decisions-2026-11-15.md` and are recorded here so that counsel reviews against them.

| Topic | Decision | Source |
|---|---|---|
| First jurisdictions | Both the European Union and the United States from the start. | decision 13 |
| Sealing party | The operator seals by default. A tenant's own key and certificate are used where the tenant supplies them. | decision 14 |
| Seal level | PAdES B-LT in phase 2, B-LTA in phase 4. | decision 15 |
| Evidence retention | Kept as long as the signed document exists; deleted with it. | decision 31 |

The jurisdictions to review against are described in ADR 0361 (J1, the European Union: eIDAS and the form rules of the member states the owner names; J2, the United States: ESIGN, the UETA as enacted in the states the owner names, and the consumer-consent rule). The member states and the US states are not named yet. They are the owner's to name before counsel starts.

## What counsel is asked to review

| Item | Where it is |
|---|---|
| Interface strings of the send dialog, the guided bar, the consent step and the signing ceremony | `packages/ui/src/i18n/en-GB.ts` (keys under `workflow.`, `fill.` and the signing keys) |
| The native description of what is offered, and the phrases the wording check allows and forbids | `packages/authority/src/workflow/language.ts` (`NATIVE_SIGNING_DESCRIPTION`, `findOverclaims`; the maintained phrase list of FRW-058) |
| The consent text and how acceptance is recorded | `packages/authority/src/workflow/consent.ts` (the text itself is held by the service per workflow: FRW-044) |
| The certificate template | `packages/authority/src/workflow/certificate.ts` (`CERTIFICATE_STATEMENT`) and the certificate pages (ADR 0400) |
| The evidence record and the bundle | FRW-055 (ADR 0402) and the retention rule of FRW-084 (ADR 0394) |
| The documentation that describes signing | `apps/reference-host/docs/integration-guide.md` (signing and identity), `docs/spec/12-fields-rules-workflow.md` §8.3 |

## Outcome

None. No counsel has reviewed any of the items above.

When a review takes place, record here: who reviewed (name and firm), the date, the jurisdictions and the version of the repository reviewed, each item with its finding, the changes asked for, and the date they were made. Then change the status line at the top to `Outcome status: recorded (date)`, and update the maintained phrase list of FRW-058 if the outcome asks for it.

## Launch gate

`packages/authority/test/frw-087.no-production-claim.test.ts` reads the status line above. While it says that no review has taken place, the test fails if a README, a guide or the product record says that sealing, certificates or signing are available for production use.
