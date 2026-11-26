<!--
  The adoption and signing step of the ceremony (FRW-045, FRW-046; 12 §8.1 steps 2 and 3, §11). The
  participant adopts a signature, and separately initials, by typing (the default, from the
  keyboard), drawing or uploading an image, and then signs the field they activated. The typed name
  is shown as text, which is what assistive technology reads; the canvas that draws it is only a
  picture. Drawing is one alternative, never required: typing is always offered beside it. The image
  goes to the asset worker through the service; the server writes the field (FRW-046), and every
  answer is said in words. The words are the shell's external strings; the label and the role are the
  document's text.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import { onMount, tick, untrack } from 'svelte';
  import { useShell } from '../context.ts';
  import {
    declineProblem,
    LOADING,
    paragraphsOf,
    stageOf,
    type ConsentStage,
  } from '../shell/consent-step.ts';
  import type {
    SignatureAdoption,
    SignatureKind,
    SignatureMode,
    SignRequest,
    SigningService,
  } from '../core-api.ts';
  import {
    adoptionFilename,
    DEFAULT_SIGNATURE_MODE,
    draftProblem,
    otherKind,
    SIGNATURE_MODES,
    typedPreview,
    UPLOAD_ACCEPT,
  } from '../shell/signature-adoption.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    service: SigningService;
    request: SignRequest;
    /** Called when the step asks to close. */
    onClose: () => void;
    /** Called once the server has signed the field. */
    onSigned?: () => void;
  }

  let { service, request, onClose, onSigned }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-sign`;

  // The kind being adopted: the field's own, or the other one when the participant switches. Each
  // kind is adopted on its own (FRW-045 criterion 4).
  let kind = $state<SignatureKind>(untrack(() => request.kind));
  let mode = $state<SignatureMode>(DEFAULT_SIGNATURE_MODE);
  let typed = $state('');
  let drawn = $state(false);
  let file = $state.raw<File | null>(null);
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let announcement = $state('');
  // What the participant adopted in this step or earlier in the visit, by kind.
  let adopted = $state<Record<SignatureKind, SignatureAdoption | null>>({
    signature: untrack(() => service.adopted('signature')),
    initials: untrack(() => service.adopted('initials')),
  });
  let changing = $state(false);

  const current = $derived(adopted[kind]);
  const editing = $derived(current === null || changing);
  const preview = $derived(typedPreview(typed));
  const missing = $derived(
    draftProblem({
      mode,
      typed,
      drawn,
      file: file ? { name: file.name, type: file.type } : null,
    }),
  );
  // The field is signed with the adoption of its own kind.
  const signable = $derived(adopted[request.kind] !== null && kind === request.kind && !changing);

  // --- The consent step (FRW-044) ------------------------------------------------------------
  // It comes before any signing action: while the text has not been accepted, the adoption and the
  // signing are not offered at all. Without a consent service the step is not shown.
  const consent = untrack(() => service.consent);
  let stage = $state.raw<ConsentStage>(consent ? LOADING : { kind: 'proceed' });
  let declining = $state(false);
  let declined = $state(false);
  let reason = $state('');

  async function loadConsent(): Promise<void> {
    if (!consent) return;
    stage = LOADING;
    try {
      stage = stageOf(await consent.load());
    } catch {
      stage = { kind: 'unavailable' };
    }
  }
  onMount(() => {
    void loadConsent();
  });

  // The controls of a new stage appear after the dialog opened, so focus follows them: the text when it
  // is shown, the first control of the adoption after the acceptance, the close button after a decline.
  let root = $state<HTMLElement | undefined>();
  $effect(() => {
    void stage.kind;
    void declined;
    if (!root) return;
    void tick().then(() => root?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
  });

  async function accept(): Promise<void> {
    if (busy || !consent) return;
    busy = true;
    problem = null;
    announcement = tr.t('consent.accepting');
    try {
      const outcome = await consent.accept();
      if (outcome.ok) {
        stage = { kind: 'proceed' };
        shell.announce('announce.consent.accepted');
      } else {
        problem = tr.t(
          outcome.reason === 'forbidden' ? 'consent.result.forbidden' : 'consent.result.failed',
        );
        announcement = problem;
      }
    } catch {
      problem = tr.t('consent.result.failed');
    } finally {
      busy = false;
    }
  }

  async function decline(): Promise<void> {
    if (busy || !consent) return;
    const missingReason = declineProblem(reason);
    if (missingReason !== null) {
      problem = tr.text(missingReason);
      return;
    }
    busy = true;
    problem = null;
    try {
      const outcome = await consent.decline(reason.trim());
      if (outcome.ok) {
        declined = true;
        shell.announce('announce.consent.declined');
      } else {
        problem = tr.t(
          outcome.reason === 'reason_required' ? 'consent.decline.problem' : 'consent.result.failed',
        );
        announcement = problem;
      }
    } catch {
      problem = tr.t('consent.result.failed');
    } finally {
      busy = false;
    }
  }

  function modeLabel(m: SignatureMode): string {
    return tr.text(`signature.mode.${m}`);
  }

  function choose(next: SignatureMode): void {
    mode = next;
    problem = null;
  }

  /** Moves among the modes with the arrow keys, as radio buttons do. */
  function modeKey(event: KeyboardEvent, index: number): void {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = SIGNATURE_MODES[(index + step + SIGNATURE_MODES.length) % SIGNATURE_MODES.length]!;
    choose(next);
    const group = (event.currentTarget as HTMLElement).parentElement;
    group?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  }

  function switchKind(): void {
    kind = otherKind(kind);
    changing = false;
    problem = null;
    typed = '';
    drawn = false;
    file = null;
    clearCanvas();
  }

  // --- The drawing ---------------------------------------------------------------------------
  let canvas = $state<HTMLCanvasElement | undefined>();
  // Set through the style object: the shell's content security policy restricts inline styles.
  $effect(() => {
    if (!canvas) return;
    canvas.style.width = '100%';
    canvas.style.maxWidth = '20em';
    canvas.style.border = '1px solid currentColor';
    canvas.style.touchAction = 'none';
  });
  let stroking = false;

  function point(event: PointerEvent): { x: number; y: number } {
    const box = canvas!.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * canvas!.width,
      y: ((event.clientY - box.top) / box.height) * canvas!.height,
    };
  }

  function down(event: PointerEvent): void {
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    stroking = true;
    canvas.setPointerCapture?.(event.pointerId);
    const p = point(event);
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.strokeStyle = '#000';
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x + 0.01, p.y + 0.01);
    g.stroke();
    drawn = true;
  }

  function move(event: PointerEvent): void {
    if (!stroking || !canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const p = point(event);
    g.lineTo(p.x, p.y);
    g.stroke();
  }

  function up(): void {
    stroking = false;
  }

  function clearCanvas(): void {
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
  }

  // --- The image ------------------------------------------------------------------------------
  function toBlob(source: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => source.toBlob((b) => resolve(b), 'image/png'));
  }

  /** The typed text as a picture: a transparent PNG with the text in black. */
  async function typedImage(text: string): Promise<Blob | null> {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 200;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#000';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.font = `italic ${kind === 'initials' ? 96 : 64}px "Segoe Script", "Brush Script MT", cursive, serif`;
    g.fillText(text, c.width / 2, c.height / 2, c.width - 20);
    return toBlob(c);
  }

  async function imageFor(): Promise<{ blob: Blob; name: string } | null> {
    if (mode === 'typed') {
      const blob = await typedImage(preview);
      return blob ? { blob, name: adoptionFilename(kind, mode, 'image/png') } : null;
    }
    if (mode === 'drawn') {
      const blob = canvas ? await toBlob(canvas) : null;
      return blob ? { blob, name: adoptionFilename(kind, mode, 'image/png') } : null;
    }
    return file ? { blob: file, name: adoptionFilename(kind, mode, file.type) } : null;
  }

  async function adopt(): Promise<void> {
    if (busy) return;
    if (missing !== null) {
      problem = tr.text(missing);
      return;
    }
    busy = true;
    problem = null;
    announcement = tr.t('signature.adopting');
    try {
      const image = await imageFor();
      if (!image) {
        problem = tr.t('signature.result.failed');
        return;
      }
      const outcome = await service.adopt(kind, mode, image.blob, image.name);
      if (outcome.ok) {
        adopted = { ...adopted, [kind]: outcome.adoption };
        changing = false;
        announcement = tr.t(
          kind === 'signature' ? 'announce.signature.adopted' : 'announce.initials.adopted',
        );
        shell.announce(kind === 'signature' ? 'announce.signature.adopted' : 'announce.initials.adopted');
      } else {
        problem = tr.t(
          outcome.reason === 'rejected' ? 'signature.result.rejected' : 'signature.result.failed',
        );
        announcement = problem;
      }
    } catch {
      problem = tr.t('signature.result.failed');
    } finally {
      busy = false;
    }
  }

  async function sign(): Promise<void> {
    const adoption = adopted[request.kind];
    if (busy || adoption === null) return;
    busy = true;
    problem = null;
    try {
      const outcome = await service.sign(request.id, adoption);
      if (outcome.ok) {
        shell.announce('announce.signature.signed', { label: request.label });
        onSigned?.();
        onClose();
      } else {
        problem = tr.t(`signature.sign.${outcome.reason}`);
        announcement = problem;
      }
    } catch {
      problem = tr.t('signature.sign.failed');
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  name="sign"
  title={stage.kind === 'proceed' ? tr.t(`dialog.sign.title.${kind}`) : tr.t('consent.title')}
  {onClose}
>
  <div class="de-form de-sign" bind:this={root}>
    {#if declined}
      <p data-declined role="status">{tr.t('consent.declined')}</p>
      <div class="de-dialog-actions">
        <button type="button" class="de-button" data-autofocus onclick={() => onClose()}
          >{tr.t('dialog.close')}</button
        >
      </div>
    {:else if stage.kind === 'loading'}
      <p role="status" data-consent-loading>{tr.t('consent.loading')}</p>
      <div class="de-dialog-actions">
        <button type="button" class="de-button" data-autofocus onclick={() => onClose()}
          >{tr.t('dialog.cancel')}</button
        >
      </div>
    {:else if stage.kind === 'unavailable'}
      <p class="de-error" role="alert" data-consent-unavailable>{tr.t('consent.result.failed')}</p>
      <div class="de-dialog-actions">
        <button
          type="button"
          class="de-button de-button-primary"
          data-autofocus
          data-consent-retry
          onclick={loadConsent}>{tr.t('consent.retry')}</button
        >
        <button type="button" class="de-button" onclick={() => onClose()}
          >{tr.t('dialog.cancel')}</button
        >
      </div>
    {:else if stage.kind === 'required'}
      <p class="de-hint" id={`${id}-consent-intro`}>{tr.t('consent.intro')}</p>
      <!-- The text is in a focusable region: it is read in full with a keyboard or a screen reader,
           and scrolls inside itself (a scrollable region must be focusable). Nothing here is
           pre-selected. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="de-consent-text"
        role="region"
        tabindex="0"
        aria-label={tr.t('consent.region')}
        aria-describedby={`${id}-consent-intro`}
        data-consent-text
        data-text-id={stage.consent.textId}
        data-text-version={stage.consent.version}
        data-autofocus
      >
        {#each paragraphsOf(stage.consent.text) as paragraph, i (i)}
          <p>{paragraph}</p>
        {/each}
      </div>
      {#if declining}
        <label for={`${id}-decline-reason`}>{tr.t('consent.decline.label')}</label>
        <textarea
          id={`${id}-decline-reason`}
          class="de-input"
          rows="3"
          data-decline-reason
          bind:value={reason}
        ></textarea>
        {#if problem}
          <p class="de-error" role="alert" data-problem>{problem}</p>
        {/if}
        <div class="de-dialog-actions">
          <button
            type="button"
            class="de-button de-button-primary"
            data-decline-confirm
            disabled={busy}
            onclick={decline}>{tr.t('consent.decline.confirm')}</button
          >
          <button
            type="button"
            class="de-button"
            data-decline-back
            onclick={() => {
              declining = false;
              problem = null;
            }}>{tr.t('consent.decline.back')}</button
          >
        </div>
      {:else}
        {#if problem}
          <p class="de-error" role="alert" data-problem>{problem}</p>
        {/if}
        <div class="de-dialog-actions">
          <button
            type="button"
            class="de-button de-button-primary"
            data-accept
            disabled={busy}
            onclick={accept}>{tr.t('consent.accept')}</button
          >
          <button
            type="button"
            class="de-button"
            data-decline
            onclick={() => {
              declining = true;
              problem = null;
            }}>{tr.t('consent.decline')}</button
          >
          <button type="button" class="de-button" onclick={() => onClose()}
            >{tr.t('dialog.cancel')}</button
          >
        </div>
      {/if}
    {:else}
    <p class="de-hint" id={`${id}-intro`}>{tr.t('signature.intro')}</p>
    <p class="de-hint" data-sign-field>
      {tr.t('signature.field', { label: request.label })}{request.role ? ` (${request.role})` : ''}
    </p>

    {#if !editing && current}
      <p data-adopted={kind} data-mode={current.mode}>
        {tr.t(`signature.adopted.${kind}`, { mode: modeLabel(current.mode) })}
      </p>
      <button type="button" class="de-button" onclick={() => (changing = true)}
        >{tr.t('signature.change')}</button
      >
    {:else}
      <div role="radiogroup" class="de-sign-modes" aria-label={tr.t('signature.mode.label')}>
        {#each SIGNATURE_MODES as m, i (m)}
          <button
            type="button"
            role="radio"
            class="de-button"
            data-mode={m}
            aria-checked={mode === m}
            tabindex={mode === m ? 0 : -1}
            data-autofocus={mode === m ? '' : undefined}
            onclick={() => choose(m)}
            onkeydown={(e) => modeKey(e, i)}>{modeLabel(m)}</button
          >
        {/each}
      </div>

      {#if mode === 'typed'}
        <label for={`${id}-typed`}>{tr.t(`signature.typed.${kind}`)}</label>
        <input
          id={`${id}-typed`}
          class="de-input"
          type="text"
          autocomplete="off"
          bind:value={typed}
          aria-describedby={`${id}-preview`}
        />
        <p id={`${id}-preview`} class="de-sign-preview" data-typed-preview>
          <span class="de-hint">{tr.t('signature.preview.label')}: </span>
          {#if preview === ''}
            <span data-preview-empty>{tr.t('signature.preview.empty')}</span>
          {:else}
            <span data-preview-text>{preview}</span>
          {/if}
        </p>
      {:else if mode === 'drawn'}
        <p class="de-hint">{tr.t('signature.drawn.hint')}</p>
        <canvas
          bind:this={canvas}
          class="de-sign-canvas"
          width="600"
          height="200"
          aria-label={tr.t('signature.drawn.canvas')}
          onpointerdown={down}
          onpointermove={move}
          onpointerup={up}
          onpointercancel={up}
        ></canvas>
        <button type="button" class="de-button" data-clear-drawing onclick={clearCanvas}
          >{tr.t('signature.drawn.clear')}</button
        >
      {:else}
        <label for={`${id}-file`}>{tr.t('signature.uploaded.label')}</label>
        <input
          id={`${id}-file`}
          class="de-input"
          type="file"
          accept={UPLOAD_ACCEPT}
          onchange={(e) => (file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)}
        />
      {/if}

      <div class="de-dialog-actions">
        <button
          type="button"
          class="de-button de-button-primary"
          data-adopt
          disabled={busy}
          onclick={adopt}>{tr.t('signature.adopt')}</button
        >
      </div>
    {/if}

    {#if problem}
      <p class="de-error" role="alert" data-problem>{problem}</p>
    {/if}

    <div class="de-dialog-actions">
      <button type="button" class="de-button" data-switch-kind onclick={switchKind}
        >{tr.t(`signature.switch.${otherKind(kind)}`)}</button
      >
      <button
        type="button"
        class="de-button de-button-primary"
        data-sign
        disabled={!signable || busy}
        onclick={sign}>{tr.t('signature.sign')}</button
      >
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
    {/if}
    <div class="de-visually-hidden" role="status" data-sign-live>{announcement}</div>
  </div>
</Dialog>
