<!--
  The rule builder (FRW-024; 12 §5, §11): the rules of the document as sentences, and a form to
  add one or change one. A rule is a condition (one comparison) and effects on fields, with an
  optional otherwise. Every fragment of a sentence is a string of the catalogue (`t`), and the
  field keys, rule names and values are the document's content. The form checks that something is
  chosen; whether the keys exist and whether the set of rules is valid is the core's answer, shown
  here with a button for each key it names, which moves to that field. A rule that is not of the
  sentence form is shown as stored and cannot be changed. Without the right to change the
  definitions (`readOnly`) every control that changes anything is disabled. Every control is a
  native control, so the keyboard reaches all of them in order.
-->
<script lang="ts">
  import type {
    RuleChangeResult,
    RuleEffectName,
    RuleItem,
    RuleOperatorName,
    RulePartsView,
  } from '../core-api.ts';
  import {
    RULE_EFFECTS,
    RULE_OPERATORS,
    OPERATOR_KEYS,
    emptyForm,
    formFromParts,
    formProblems,
    partsFromForm,
    sameForm,
    sentenceOf,
    type FormProblem,
    type RuleForm,
  } from '../shell/rule-builder.ts';

  interface Props {
    rules: readonly RuleItem[];
    fields: readonly { readonly key: string; readonly label: string }[];
    readOnly: boolean;
    nextId: () => string;
    t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
    onsave: (input: {
      id: string;
      parts: RulePartsView;
      replace?: string;
    }) => RuleChangeResult;
    onremove: (id: string) => RuleChangeResult;
    onshow?: (key: string) => void;
  }

  let { rules, fields, readOnly, nextId, t, onsave, onremove, onshow }: Props = $props();

  /** The rule being changed, or null for a new one; `form` is null while no form is open. */
  let replacing = $state<string | null>(null);
  let form = $state<RuleForm | null>(null);
  let original = $state<RuleForm | null>(null);
  let formProblemList = $state<FormProblem[]>([]);
  let refusal = $state<{ text: string; problems: { message: string; keys: readonly string[] }[] }>({
    text: '',
    problems: [],
  });
  let status = $state('');
  let titleEl: HTMLElement | undefined = $state();

  const firstKey = $derived(fields[0]?.key ?? '');

  function open(item: RuleItem | null): void {
    refusal = { text: '', problems: [] };
    formProblemList = [];
    status = '';
    if (item === null) {
      form = emptyForm(nextId(), firstKey);
      replacing = null;
    } else if (item.parts !== null) {
      form = formFromParts(item.id, item.parts);
      replacing = item.id;
    } else return;
    original = JSON.parse(JSON.stringify(form)) as RuleForm;
    queueMicrotask(() => titleEl?.focus());
  }

  function close(): void {
    form = null;
    original = null;
    replacing = null;
  }

  function describe(result: RuleChangeResult): void {
    if (result.ok) return;
    if (result.reason === 'rule_limit')
      refusal = { text: t('rule.refused.rule_limit', { limit: result.limit }), problems: [] };
    else if (result.reason === 'invalid_rules')
      refusal = { text: t('rule.refused.invalid_rules'), problems: [...result.problems] };
    else refusal = { text: t(`rule.refused.${result.reason}`), problems: [] };
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (readOnly || form === null) return;
    refusal = { text: '', problems: [] };
    status = '';
    const found = formProblems(form);
    formProblemList = found;
    if (found.length > 0) return;
    if (original !== null && replacing !== null && sameForm(form, original)) {
      status = t('rule.unchanged');
      return;
    }
    const result = onsave({
      id: form.id.trim(),
      parts: partsFromForm(form),
      ...(replacing !== null ? { replace: replacing } : {}),
    });
    if (result.ok) {
      status = t('rule.saved');
      close();
    } else describe(result);
  }

  function remove(item: RuleItem): void {
    if (readOnly) return;
    refusal = { text: '', problems: [] };
    const result = onremove(item.id);
    if (result.ok) status = t('rule.deleted');
    else describe(result);
  }

  function addRow(list: 'then' | 'otherwise'): void {
    form?.[list].push({ effect: 'show', key: firstKey });
  }

  function removeRow(list: 'then' | 'otherwise', index: number): void {
    form?.[list].splice(index, 1);
  }

  const preview = $derived.by(() => {
    if (form === null || formProblems(form).length > 0) return '';
    return sentenceOf(partsFromForm(form), t);
  });

  const problemText = (p: FormProblem): string => t(`rule.problem.${p.code}`);
</script>

<section class="de-rule-builder" aria-labelledby="rb-title">
  <h2 id="rb-title">{t('rule.title')}</h2>

  {#if readOnly}
    <p role="status" data-status="read-only">{t('rule.readOnly')}</p>
  {/if}

  {#if rules.length === 0}
    <p data-rules="empty">{t('rule.none')}</p>
  {:else}
    <ul class="de-rule-list" data-rules="list">
      {#each rules as item (item.id)}
        <li data-rule={item.id}>
          {#if item.parts !== null}
            <p class="de-rule-sentence">{sentenceOf(item.parts, t)}</p>
          {:else}
            <p>{t('rule.json')}</p>
            <!-- A long tree scrolls, so the keyboard must be able to reach it. -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <pre class="de-rule-json" tabindex="0" aria-label={item.id}>{item.json}</pre>
          {/if}
          <div class="de-rule-actions">
            <button
              type="button"
              class="de-action"
              disabled={readOnly || item.parts === null}
              onclick={() => open(item)}
              aria-label={t('rule.edit', { id: item.id })}>{t('rule.form.change')}</button
            >
            <button
              type="button"
              class="de-action"
              disabled={readOnly}
              onclick={() => remove(item)}
              aria-label={t('rule.delete', { id: item.id })}>{t('rule.delete', { id: '' }).trim()}</button
            >
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if form === null}
    <button type="button" class="de-action" disabled={readOnly} onclick={() => open(null)}
      >{t('rule.add')}</button
    >
  {:else}
    <form class="de-rule-form" onsubmit={submit} novalidate aria-labelledby="rb-form-title">
      <h3 id="rb-form-title" tabindex="-1" bind:this={titleEl}>
        {replacing === null ? t('rule.form.new') : t('rule.form.change')}
      </h3>

      <label class="de-field" for="rb-id">{t('rule.form.id')}</label>
      <input
        id="rb-id"
        class="de-input"
        type="text"
        bind:value={form.id}
        disabled={readOnly}
        aria-invalid={formProblemList.some((p) => p.code === 'id') ? 'true' : undefined}
      />

      <fieldset>
        <legend>{t('rule.form.condition')}</legend>
        {#each ['left', 'right'] as side (side)}
          {@const operand = side === 'left' ? form.left : form.right}
          {#if side === 'right'}
            <label class="de-field" for="rb-op">{t('rule.form.operator')}</label>
            <select id="rb-op" class="de-input" bind:value={form.operator} disabled={readOnly}>
              {#each RULE_OPERATORS as op (op)}
                <option value={op}>{t(OPERATOR_KEYS[op as RuleOperatorName])}</option>
              {/each}
            </select>
          {/if}
          <label class="de-field" for={`rb-${side}-kind`}
            >{t(`rule.form.${side}`)}: {t('rule.form.kind')}</label
          >
          <select
            id={`rb-${side}-kind`}
            class="de-input"
            bind:value={operand.kind}
            disabled={readOnly}
          >
            <option value="field">{t('rule.form.kind.field')}</option>
            <option value="literal">{t('rule.form.kind.literal')}</option>
          </select>
          {#if operand.kind === 'field'}
            <label class="de-field" for={`rb-${side}-field`}
              >{t(`rule.form.${side}`)}: {t('rule.form.field')}</label
            >
            <select
              id={`rb-${side}-field`}
              class="de-input"
              bind:value={operand.value}
              disabled={readOnly}
              aria-invalid={formProblemList.some((p) => p.code === side) ? 'true' : undefined}
            >
              <option value="">{t('rule.form.choose')}</option>
              {#each fields as f (f.key)}
                <option value={f.key}>{f.label} ({f.key})</option>
              {/each}
            </select>
          {:else}
            <label class="de-field" for={`rb-${side}-value`}
              >{t(`rule.form.${side}`)}: {t('rule.form.value')}</label
            >
            <input
              id={`rb-${side}-value`}
              class="de-input"
              type="text"
              bind:value={operand.value}
              disabled={readOnly}
              aria-invalid={formProblemList.some((p) => p.code === side) ? 'true' : undefined}
            />
          {/if}
        {/each}
      </fieldset>

      {#each ['then', 'otherwise'] as list (list)}
        {#if list === 'then' || form.hasOtherwise}
          {@const rows = list === 'then' ? form.then : form.otherwise}
          <fieldset>
            <legend>{t(list === 'then' ? 'rule.form.then' : 'rule.form.otherwise')}</legend>
            {#each rows as row, i (i)}
              <div class="de-rule-row">
                <label class="de-field" for={`rb-${list}-${i}-effect`}
                  >{t('rule.form.effect')} {i + 1}</label
                >
                <select
                  id={`rb-${list}-${i}-effect`}
                  class="de-input"
                  bind:value={row.effect}
                  disabled={readOnly}
                >
                  {#each RULE_EFFECTS as name (name)}
                    <option value={name}>{t(`rule.effect.${name as RuleEffectName}`, { fields: '…' })}</option>
                  {/each}
                </select>
                <label class="de-field" for={`rb-${list}-${i}-key`}
                  >{t('rule.form.effectField')} {i + 1}</label
                >
                <select
                  id={`rb-${list}-${i}-key`}
                  class="de-input"
                  bind:value={row.key}
                  disabled={readOnly}
                  aria-invalid={row.key === '' &&
                  formProblemList.some((p) => p.code === (list === 'then' ? 'effect' : 'otherwiseEffect'))
                    ? 'true'
                    : undefined}
                >
                  <option value="">{t('rule.form.choose')}</option>
                  {#each fields as f (f.key)}
                    <option value={f.key}>{f.label} ({f.key})</option>
                  {/each}
                </select>
                <button
                  type="button"
                  class="de-action"
                  disabled={readOnly || (list === 'then' && rows.length === 1)}
                  onclick={() => removeRow(list as 'then' | 'otherwise', i)}
                  >{t('rule.form.removeEffect')}</button
                >
              </div>
            {/each}
            <button
              type="button"
              class="de-action"
              disabled={readOnly}
              onclick={() => addRow(list as 'then' | 'otherwise')}>{t('rule.form.addEffect')}</button
            >
          </fieldset>
        {/if}
      {/each}

      <label class="de-field">
        <input
          type="checkbox"
          checked={form.hasOtherwise}
          disabled={readOnly}
          onchange={(e) => {
            if (form === null) return;
            form.hasOtherwise = e.currentTarget.checked;
            if (form.hasOtherwise && form.otherwise.length === 0) addRow('otherwise');
          }}
        />
        {t('rule.form.hasOtherwise')}
      </label>

      {#if preview !== ''}
        <p class="de-rule-preview"><strong>{t('rule.form.preview')}:</strong> {preview}</p>
      {/if}

      {#if formProblemList.length > 0}
        <div role="alert" data-rules="problems">
          <p>{t('rule.problems')}</p>
          <ul>
            {#each formProblemList as p (p.code)}
              <li>{problemText(p)}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if refusal.text !== ''}
        <div role="alert" data-rules="refusal">
          <p>{refusal.text}</p>
          {#if refusal.problems.length > 0}
            <ul>
              {#each refusal.problems as problem, i (i)}
                <li>
                  {problem.message}
                  {#each problem.keys as key (key)}
                    <button
                      type="button"
                      class="de-action"
                      aria-label={t('rule.goTo', { key })}
                      onclick={() => onshow?.(key)}>{key}</button
                    >
                  {/each}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      <div class="de-rule-actions">
        <button type="submit" class="de-action" disabled={readOnly}>{t('rule.form.save')}</button>
        <button type="button" class="de-action" onclick={close}>{t('rule.form.cancel')}</button>
      </div>
    </form>
  {/if}

  <p role="status" data-rules="status">{status}</p>
</section>
