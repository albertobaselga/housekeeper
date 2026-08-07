<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import { provideAppContext } from '$lib/auth/context';
  import { untrack } from 'svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
  const context = provideAppContext(untrack(() => data.context));
</script>

<AppShell {context}>
  {@render children()}
</AppShell>
