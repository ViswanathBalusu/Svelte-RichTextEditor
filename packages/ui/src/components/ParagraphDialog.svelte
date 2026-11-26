<!--
  The paragraph dialog (UX-102 criterion 3; 02 §10; FE-104, FE-129): the indents and tab stops of
  the selected paragraphs as fields, the keyboard form of every drag on the ruler. Applying runs
  `setParagraphFormat`, the same command the ruler runs, so the guards are the same.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import { useShell } from '../context.ts';
  import type { ParagraphFormatView, TabStopView } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import {
    BORDER_SIDES,
    TRI_OPTIONS,
    convertLineSpacing,
    dialogFields,
    dialogPatch,
    type DialogField,
  } from '../shell/paragraph-dialog.ts';
  import { MAX_TABS } from '../shell/ruler.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    format: ParagraphFormatView;
    onClose: () => void;
  }

  let { format, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-paragraph`;

  // svelte-ignore state_referenced_locally
  let fields = $state(dialogFields(format));
  let invalid = $state<readonly DialogField[]>([]);

  const ALIGN_NAMES: Record<TabStopView['align'], StringKey> = {
    left: 'dialog.paragraph.align.left',
    center: 'dialog.paragraph.align.center',
    right: 'dialog.paragraph.align.right',
    decimal: 'dialog.paragraph.align.decimal',
  };
  const LEADER_NAMES: Record<TabStopView['leader'], StringKey> = {
    none: 'dialog.paragraph.leader.none',
    dot: 'dialog.paragraph.leader.dot',
    hyphen: 'dialog.paragraph.leader.hyphen',
    underscore: 'dialog.paragraph.leader.underscore',
    middleDot: 'dialog.paragraph.leader.middleDot',
    heavy: 'dialog.paragraph.leader.heavy',
  };
  const ALIGNS: readonly TabStopView['align'][] = ['left', 'center', 'right', 'decimal'];
  const LEADERS: readonly TabStopView['leader'][] = [
    'none',
    'dot',
    'hyphen',
    'underscore',
    'middleDot',
    'heavy',
  ];

  const ALIGNMENTS = ['start', 'center', 'end', 'justify', 'distribute'] as const;
  const LINE_RULES = ['multiple', 'atLeast', 'exact'] as const;
  const BORDER_STYLES = ['none', 'single', 'double', 'dotted', 'dashed', 'thick'] as const;

  const mixed = $derived(
    format.indentLeft === null ||
      format.indentRight === null ||
      format.indentFirstLine === null ||
      format.tabs === null ||
      (format.options?.mixed.length ?? 0) > 0,
  );

  // The line spacing is typed in lines under `multiple` and in points under the other rules, so a
  // change of rule converts what is typed to the same space.
  // svelte-ignore state_referenced_locally
  let lastRule = fields.options?.lineRule ?? '';
  function changeRule(next: string): void {
    const o = fields.options;
    if (!o) return;
    if (lastRule !== '' && next !== '')
      o.lineSpacing = convertLineSpacing(
        o.lineSpacing,
        lastRule as (typeof LINE_RULES)[number],
        next as (typeof LINE_RULES)[number],
      );
    o.lineRule = next;
    lastRule = next;
  }

  function addTab(): void {
    if (fields.tabs.length >= MAX_TABS) return;
    const last = fields.tabs[fields.tabs.length - 1];
    const next = last ? Number(last.position.replace(',', '.')) + 1 : 2;
    fields.tabs.push({
      position: String(Number.isFinite(next) ? next : 2),
      align: 'left',
      leader: 'none',
    });
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const result = dialogPatch(format, { ...fields, tabs: fields.tabs.map((row) => ({ ...row })) });
    invalid = result.invalid;
    if (result.invalid.length > 0) return;
    if (result.patch === null) {
      onClose();
      return;
    }
    const done = shell.core.runNamed?.('setParagraphFormat', result.patch) ?? false;
    shell.announceText(tr.t(done ? 'announce.paragraph.set' : 'announce.paragraph.failed'));
    if (done) onClose();
  }

  const bad = (field: DialogField): boolean => invalid.includes(field);
</script>

<Dialog name="paragraph" title={tr.t('dialog.paragraph.title')} {onClose}>
  <form class="de-form" onsubmit={submit}>
    {#if mixed}
      <p class="de-hint">{tr.t('dialog.paragraph.mixed')}</p>
    {/if}
    {#each [{ key: 'left', label: 'dialog.paragraph.left' }, { key: 'right', label: 'dialog.paragraph.right' }, { key: 'firstLine', label: 'dialog.paragraph.firstLine' }] as const as row, i (row.key)}
      <label class="de-field" for={`${id}-${row.key}`}>{tr.t(row.label)}</label>
      <input
        id={`${id}-${row.key}`}
        class="de-input"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        data-autofocus={i === 0 ? '' : undefined}
        bind:value={fields[row.key]}
        aria-invalid={bad(row.key) ? 'true' : undefined}
        aria-describedby={bad(row.key) ? `${id}-error` : undefined}
      />
    {/each}
    {#if fields.options}
      {@const o = fields.options}
      <label class="de-field" for={`${id}-align`}>{tr.t('dialog.paragraph.alignment')}</label>
      <select id={`${id}-align`} class="de-input" bind:value={o.align}>
        {#if o.align === ''}<option value="">{tr.t('dialog.paragraph.differs')}</option>{/if}
        {#each ALIGNMENTS as align (align)}
          <option value={align}>{tr.t(`dialog.paragraph.alignment.${align}`)}</option>
        {/each}
      </select>
      {#each [{ key: 'spaceBefore', label: 'dialog.paragraph.spaceBefore' }, { key: 'spaceAfter', label: 'dialog.paragraph.spaceAfter' }] as const as row (row.key)}
        <label class="de-field" for={`${id}-${row.key}`}>{tr.t(row.label)}</label>
        <input
          id={`${id}-${row.key}`}
          class="de-input"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          bind:value={o[row.key]}
          aria-invalid={bad(row.key) ? 'true' : undefined}
          aria-describedby={bad(row.key) ? `${id}-error` : undefined}
        />
      {/each}
      <label class="de-field" for={`${id}-lineRule`}>{tr.t('dialog.paragraph.lineRule')}</label>
      <select
        id={`${id}-lineRule`}
        class="de-input"
        value={o.lineRule}
        onchange={(event) => changeRule(event.currentTarget.value)}
      >
        {#if o.lineRule === ''}<option value="">{tr.t('dialog.paragraph.differs')}</option>{/if}
        {#each LINE_RULES as rule (rule)}
          <option value={rule}>{tr.t(`dialog.paragraph.lineRule.${rule}`)}</option>
        {/each}
      </select>
      <label class="de-field" for={`${id}-lineSpacing`}
        >{tr.t(
          o.lineRule === 'multiple'
            ? 'dialog.paragraph.lineSpacing.lines'
            : 'dialog.paragraph.lineSpacing.points',
        )}</label
      >
      <input
        id={`${id}-lineSpacing`}
        class="de-input"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        bind:value={o.lineSpacing}
        aria-invalid={bad('lineSpacing') ? 'true' : undefined}
        aria-describedby={bad('lineSpacing') ? `${id}-error` : undefined}
      />
    {/if}
    <fieldset class="de-fieldset">
      <legend>{tr.t('dialog.paragraph.tabs')}</legend>
      {#if fields.tabs.length === 0}
        <p class="de-hint">{tr.t('dialog.paragraph.tabs.none')}</p>
      {/if}
      {#each fields.tabs as row, i (i)}
        <div class="de-paragraph-tab">
          <input
            class="de-input"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            aria-label={tr.t('dialog.paragraph.tabs.position', { n: i + 1 })}
            bind:value={row.position}
            aria-invalid={bad(`tab${i}`) ? 'true' : undefined}
            aria-describedby={bad(`tab${i}`) ? `${id}-error` : undefined}
          />
          <select
            class="de-input"
            aria-label={tr.t('dialog.paragraph.tabs.align', { n: i + 1 })}
            bind:value={row.align}
          >
            {#each ALIGNS as align (align)}
              <option value={align}>{tr.t(ALIGN_NAMES[align])}</option>
            {/each}
          </select>
          <select
            class="de-input"
            aria-label={tr.t('dialog.paragraph.tabs.leader', { n: i + 1 })}
            bind:value={row.leader}
          >
            {#each LEADERS as leader (leader)}
              <option value={leader}>{tr.t(LEADER_NAMES[leader])}</option>
            {/each}
          </select>
          <button
            type="button"
            class="de-button"
            onclick={() => fields.tabs.splice(i, 1)}
            >{tr.t('dialog.paragraph.tabs.remove', { n: i + 1 })}</button
          >
        </div>
      {/each}
      <button
        type="button"
        class="de-button"
        disabled={fields.tabs.length >= MAX_TABS}
        onclick={addTab}>{tr.t('dialog.paragraph.tabs.add')}</button
      >
    </fieldset>
    {#if fields.options}
      {@const o = fields.options}
      <fieldset class="de-fieldset">
        <legend>{tr.t('dialog.paragraph.rules')}</legend>
        <p class="de-hint">{tr.t('dialog.paragraph.rules.hint')}</p>
        {#each TRI_OPTIONS as key (key)}
          <label class="de-check">
            <input
              type="checkbox"
              checked={o[key] === true}
              indeterminate={o[key] === 'mixed'}
              onchange={(event) => (o[key] = event.currentTarget.checked)}
            />
            {tr.t(`dialog.paragraph.rule.${key}`)}
          </label>
        {/each}
      </fieldset>
      <fieldset class="de-fieldset">
        <legend>{tr.t('dialog.paragraph.borders')}</legend>
        {#each BORDER_SIDES as side (side)}
          {@const name = tr.t(`dialog.paragraph.border.${side}`)}
          {@const row = o.borders[side]}
          <div class="de-paragraph-border">
            <select
              class="de-input"
              aria-label={tr.t('dialog.paragraph.borderField.style', { side: name })}
              bind:value={row.style}
            >
              {#each BORDER_STYLES as style (style)}
                <option value={style}>{tr.t(`dialog.paragraph.borderStyle.${style}`)}</option>
              {/each}
            </select>
            <input
              class="de-input"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              aria-label={tr.t('dialog.paragraph.borderField.width', { side: name })}
              aria-invalid={bad(`border:${side}`) ? 'true' : undefined}
              aria-describedby={bad(`border:${side}`) ? `${id}-error` : undefined}
              bind:value={row.width}
            />
            <input
              class="de-input"
              type="text"
              autocomplete="off"
              aria-label={tr.t('dialog.paragraph.borderField.color', { side: name })}
              aria-invalid={bad(`border:${side}`) ? 'true' : undefined}
              aria-describedby={bad(`border:${side}`) ? `${id}-error` : undefined}
              bind:value={row.color}
            />
            <input
              class="de-input"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              aria-label={tr.t('dialog.paragraph.borderField.space', { side: name })}
              aria-invalid={bad(`border:${side}`) ? 'true' : undefined}
              aria-describedby={bad(`border:${side}`) ? `${id}-error` : undefined}
              bind:value={row.space}
            />
          </div>
        {/each}
      </fieldset>
      <label class="de-field" for={`${id}-shading`}>{tr.t('dialog.paragraph.shading')}</label>
      <input
        id={`${id}-shading`}
        class="de-input"
        type="text"
        autocomplete="off"
        bind:value={o.shading}
        aria-invalid={bad('shading') ? 'true' : undefined}
        aria-describedby={bad('shading') ? `${id}-error` : undefined}
      />
    {/if}
    {#if invalid.length > 0}
      <p class="de-error" id={`${id}-error`} role="alert">{tr.t('dialog.paragraph.invalid')}</p>
    {/if}
    <div class="de-dialog-actions">
      <button type="submit" class="de-button de-button-primary">{tr.t('dialog.apply')}</button>
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
