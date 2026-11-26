/**
 * A signing service for the shell's browser tests of the adoption and signing step (FRW-045,
 * FRW-046). The server is a stand-in: it records what the step asked of it on the returned `log`
 * (the image's type and size, the kind, the mode, the field signed) and answers from the mode.
 *
 * Modes: `ok` (the image is accepted and the field is signed), `rejected` (the asset worker refuses
 * the image), `consent` (the sign request is refused because the consent was not accepted).
 */
import type {
  AdoptOutcome,
  ReadView,
  SignatureAdoption,
  SignatureKind,
  SignatureMode,
  SignOutcome,
  SignRequest,
  SigningService,
} from '../../src/core-api.ts';

export type SigningHarnessMode = 'ok' | 'rejected' | 'consent';

export interface SigningHarnessLog {
  adopts: Array<{
    kind: SignatureKind;
    mode: SignatureMode;
    type: string;
    size: number;
    filename: string;
  }>;
  signs: Array<{ field: string; asset: string; mode: SignatureMode }>;
  dismissed: number;
}

function view<T>(initial: T): ReadView<T> & { set(next: T): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export function signingService(
  mode: SigningHarnessMode,
  log: SigningHarnessLog,
): SigningService & { activate(field: Omit<SignRequest, 'n'>): void } {
  const request = view<SignRequest | null>(null);
  const kept: Record<SignatureKind, SignatureAdoption | null> = {
    signature: null,
    initials: null,
  };
  let n = 0;
  return {
    request,
    activate(field) {
      request.set({ ...field, n: ++n });
    },
    // Three signature and initials fields in the document; each signing is one more signed (FRW-048).
    progress: () => ({ signed: log.signs.length, total: 3 }),
    adopted: (kind) => kept[kind],
    async adopt(kind, how, image, filename): Promise<AdoptOutcome> {
      log.adopts.push({ kind, mode: how, type: image.type, size: image.size, filename });
      if (mode === 'rejected') return { ok: false, reason: 'rejected' };
      const adoption = { asset: `asset-${log.adopts.length}`, mode: how };
      kept[kind] = adoption;
      return { ok: true, adoption };
    },
    async sign(field, adoption): Promise<SignOutcome> {
      if (mode === 'consent') return { ok: false, reason: 'consent' };
      log.signs.push({ field, asset: adoption.asset, mode: adoption.mode });
      return { ok: true };
    },
    dismiss() {
      log.dismissed++;
      request.set(null);
    },
  };
}
