<!--
  The bar of the preview as a role (FRW-075; 12 §11): while an author previews the document as a
  role, this region says so and holds the control that leaves the preview. It sits before the page
  in the reading and tab order, so the control is always the first stop after the toolbar and is
  reached with the keyboard. Starting and ending the preview are announced to assistive
  technology. Role names are the document's content.
-->
<script lang="ts">
  import type { ReadView } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';

  interface Props {
    preview: ReadView<string | null>;
    onLeave: () => void;
  }

  let { preview, onLeave }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  // svelte-ignore state_referenced_locally
  const view = live(preview);
  const role = $derived(view.current);
  const name = $derived.by(() => {
    if (role === null) return '';
    return shell.core.roles?.list.get().find((r) => r.id === role)?.name ?? role;
  });

  // Starting and ending are announced. A switch to another role is announced as a start.
  let announced: string | null = null;
  $effect(() => {
    const now = role;
    if (now === announced) return;
    if (now !== null) shell.announce('announce.rolePreview.on', { role: name });
    else shell.announce('announce.rolePreview.off');
    announced = now;
  });
</script>

{#if role !== null}
  <div
    class="de-role-preview-bar"
    role="region"
    aria-label={tr.t('rolePreview.label')}
    data-role-preview={role}
  >
    <span data-status="role-preview"
      >{tr.t('rolePreview.active', { role: name })}</span
    >
    <button type="button" class="de-action" data-role-preview-leave onclick={() => onLeave()}
      >{tr.t('rolePreview.leave')}</button
    >
  </div>
{/if}
