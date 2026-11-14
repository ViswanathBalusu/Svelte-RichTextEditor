# ADR 0013: A simple electronic signature with evidence and a sealed PDF natively; stronger signatures through providers

**Status:** proposed, 2026-09-18, after the first review. Needs legal review before launch.

## Context

Signing has a technical side and a legal side. Technically, e-signature products record a ceremony, keep an audit trail, and seal the final PDF with the provider's certificate, not the signer's. Legally, under eIDAS that is a simple electronic signature plus a provider seal. An advanced signature needs a unique link to the signatory, identification, sole control and change detection; a qualified signature adds a qualified certificate and a qualified signature creation device, and only it equals a handwritten signature. ESIGN and UETA in the United States turn on intent, consent and records that stay reproducible. Microsoft describes its own comparable feature as a simple electronic signature.

This architecture already has much of what evidence needs: server-side attribution, acknowledgement only after storage, and a hash-chained log that includes permission and workflow changes.

## Decision

- Natively, the platform provides a simple electronic signature: a consent step, a signing ceremony whose signature values are written by the server, an evidence record, a certificate of completion, and a final PDF from the LaTeX pipeline that a separate signing service seals with a PAdES signature and an RFC 3161 time-stamp, using a key held in a hardware security module or a key service.
- The platform records how the host says it authenticated a participant. It does not vouch for identity.
- Advanced and qualified signatures, identity verification and notarisation are reached through a `SignatureProvider` adapter that signs document hashes remotely. The Cloud Signature Consortium API is the target.
- The document service sends no e-mail or text messages. Hosts do.
- Product language never says "qualified" or "legally binding everywhere".
- The sealed PDF is never rewritten. Long-term validation data is added as incremental updates, and time-stamps are renewed on a schedule.

## Consequences

Good:
- A complete fill-and-sign flow without becoming a trust service provider.
- Evidence rests on mechanisms the architecture has anyway.
- Contact details and identity proofing stay with the host.

Bad:
- Not sufficient by itself where law demands advanced or qualified signatures.
- Evidence is personal data that must be kept for legal reasons and deleted for privacy reasons; it needs its own retention rules.
- A signing service and key management are new operational responsibilities.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Integrate an existing e-signature provider for everything | A valid first step for some deployments, and the adapter allows it, but it gives up the enforced fill permissions and the single history that are this product's point |
| Live PDF form fields signed by each signer | LaTeX's form support is limited and incompatible with tagging; viewer support varies |
| Becoming a qualified trust service provider | A regulated business of its own |
| Keys on export workers | Workers process hostile input and must hold no secrets |

## Revisit when

A target market requires advanced or qualified signatures as the default.
