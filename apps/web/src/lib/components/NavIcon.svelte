<script lang="ts">
  const symbols: Record<string, string> = {
    today: '☀',
    employment: '€',
    menu: '◌',
    recipes: '◇',
    wiki: '▤',
    search: '⌕',
    routines: '✓',
    calendar: '□',
    contacts: '☎',
    emergency: '+',
    settings: '⚙'
  };

  let { name }: { name: string } = $props();
</script>

<span class="nav-symbol" aria-hidden="true">{symbols[name] ?? '·'}</span>
