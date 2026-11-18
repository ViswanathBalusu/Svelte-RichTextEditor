# 0396. Adopting a signature: one image path for three modes

**Status:** proposed, 2026-11-18. Written while building FRW-045 (lane w4). The owner accepted the workflow design ADRs as a set (decision 184), including the proposal in the notes of FRW-045. 12 §8.1 step 2 and 05 §6.2 say that an adopted signature is an asset and that the field holds `{ asset, mode }`, and leave open how a typed name becomes an asset. Each item takes the smallest reading that works.

1. **The client makes the image.** A typed name is drawn by the client to an image (the font is the client's choice), a drawn signature is the canvas, an uploaded one is the file. All three are uploaded with `POST /documents/{id}/assets` and go through the asset worker (quarantine, validation, re-encoding, hashing, storage). `mode` records how the image was made and changes nothing on the server. The service renders no text and ships no signature font.
2. **Use is checked at signing.** `adoptSignature` (`services/document-service/src/workflow/signature-adoption.ts`) is what a use of the asset calls (the sign route, FRW-046). It refuses an asset that is not `ready` (`conflict`, with the state), one that `failed` (with the worker's reason), one that is not an image, and one whose stored bytes no longer hash to the worker's recorded hash.
3. **Whose image.** The asset must belong to the document and must have been uploaded by the person who signs. A participant signs with their own image, never another's. An asset of another document answers `not_found`, as an absent asset does.
4. **The hash.** The SHA-256 of the image is computed by the service from the stored bytes (`signatureImageHash`). The evidence takes no hash from the client (FRW-040 criterion 3).
5. **Initials.** Initials are a second image adopted the same way; the client adopts them in a second step and names the asset in the sign request of an initials field.

Not decided: whether a participant may reuse one adopted image for several fields (the sign route accepts the same asset again, since nothing in 12 forbids it); and the size and pixel limits of a signature image beyond the general asset limits.
