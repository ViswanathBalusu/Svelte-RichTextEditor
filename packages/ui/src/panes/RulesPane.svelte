<!--
  The rules pane (FRW-024; 12 §5, §11): the rule builder of components/RuleBuilderPanel.svelte over
  the core's rules port. A change is made by the core as one commit of the definitions, and needs
  `structure`; without it the builder is read-only. What the core refuses is shown in the builder
  with the keys it names, and the result is announced.
-->
<script lang="ts">
  import RuleBuilderPanel from '../components/RuleBuilderPanel.svelte';
  import { useShell } from '../context.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const service = shell.core.rules!;
  const rules = live(service.rules);
  const fields = live(service.fields);
  const canEdit = live(service.canEdit);

  const t = (key: string, params?: Readonly<Record<string, string | number>>): string =>
    tr.t(key as StringKey, params);
</script>

<section class="de-rules-pane" aria-label={tr.t('pane.rules')}>
  <RuleBuilderPanel
    rules={rules.current}
    fields={fields.current}
    readOnly={!canEdit.current}
    nextId={() => service.nextId()}
    {t}
    onsave={(input) => service.save(input)}
    onremove={(id) => service.remove(id)}
    onshow={(key) => service.showField(key)}
  />
</section>
