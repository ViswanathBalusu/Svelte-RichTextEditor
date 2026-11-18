/** The server entry of the host that is rendered on a server (FE-124 criterion 3). */
import { render } from 'svelte/server';
import SsrHost from './SsrHost.svelte';

export function renderHost(): { body: string; head: string } {
  return render(SsrHost);
}
