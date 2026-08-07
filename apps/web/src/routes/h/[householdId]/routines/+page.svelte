<script lang="ts">
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { queueOutbox } from '$lib/offline/idb';
  import { createOutboxRecord } from '$lib/offline/schema';
  import { refreshSyncStatus } from '$lib/offline/sync';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  let groups = $state(untrack(() => data.routines.groups.map((group) => ({ ...group, items: group.items.map((item) => ({ ...item })) }))));
  let done = $derived(groups.flatMap((group) => group.items).filter((item) => item.done).length);
  let total = $derived(groups.flatMap((group) => group.items).length);

  async function toggle(itemId: string): Promise<void> {
    const item = groups.flatMap((group) => group.items).find((candidate) => candidate.id === itemId);
    if (!item) return;
    item.done = !item.done;
    const id = crypto.randomUUID();
    await queueOutbox(createOutboxRecord({ id, idempotencyKey: id, householdId: context.household.id, operation: 'routine.toggle', payload: { itemId, done: item.done } }));
    await refreshSyncStatus();
  }
</script>

<svelte:head><title>Rutinas · Casa Clara</title></svelte:head>

<div class="page-wrap">
  <PageHeader eyebrow="Orden cotidiano" title="Rutinas" description="Pasos pequeños y compartidos, con progreso local aunque falte la red." />
  <section class="routine-progress card"><div><p class="eyebrow">Progreso de hoy</p><h2>{done} de {total} tareas</h2></div><progress max={total} value={done}>{done} de {total}</progress><strong>{Math.round(done / total * 100)}%</strong></section>
  <div class="routine-columns">
    {#each groups as group}
      <section class="card routine-group"><h2>{group.title}</h2>
        {#each group.items as item}
          <button type="button" class:done={item.done} aria-pressed={item.done} onclick={() => void toggle(item.id)}><span aria-hidden="true">{item.done ? '✓' : ''}</span><strong>{item.title}</strong></button>
        {/each}
      </section>
    {/each}
  </div>
</div>
