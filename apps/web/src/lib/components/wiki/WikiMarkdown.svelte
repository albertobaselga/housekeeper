<script lang="ts">
  import type { WikiBlock, WikiInline } from '$lib/wiki/markdown';

  // Pinta la estructura de bloques del render Markdown propio. Todo el texto
  // pasa por interpolación de Svelte: queda escapado por construcción y aquí
  // no existe ningún `{@html}`.
  let { blocks }: { blocks: WikiBlock[] } = $props();

  function headingTag(level: number): string {
    // El h1 lo pone la cabecera de la página; el contenido empieza en h2.
    return `h${Math.min(Math.max(level + 1, 2), 4)}`;
  }

  /**
   * Texto plano de una celda de cabecera, para que cada celda de datos lleve su
   * etiqueta al convertirse en ficha por debajo de 600 px.
   *
   * Las tablas del manual de convivencia se leían con scroll horizontal MUDO
   * dentro de la tarjeta: a 320 px no se veía ni una celda entera y la tercera
   * columna —«Avisar si», la que dice cuándo hay que llamar a la familia— se
   * partía a media palabra («Hay manchas,»). Una tabla con scroll horizontal
   * sin señal esconde justo la columna que importa.
   */
  function plain(parts: WikiInline[]): string {
    return parts.map((part) => part.text).join('');
  }
</script>

{#snippet inline(parts: WikiInline[])}
  {#each parts as part}
    {#if part.kind === 'text'}{part.text}{:else if part.kind === 'strong'}<strong>{part.text}</strong>{:else if part.kind === 'em'}<em>{part.text}</em>{:else if part.kind === 'code'}<code>{part.text}</code>{:else}<a
        href={part.href}
        target={part.internal ? undefined : '_blank'}
        rel={part.internal ? undefined : 'noopener noreferrer'}>{part.text}</a>{/if}
  {/each}
{/snippet}

<div class="wiki-markdown">
  {#each blocks as block}
    {#if block.kind === 'heading'}
      <svelte:element this={headingTag(block.level)}>{@render inline(block.inline)}</svelte:element>
    {:else if block.kind === 'paragraph'}
      <p>{@render inline(block.inline)}</p>
    {:else if block.kind === 'quote'}
      <blockquote>
        {#each block.lines as line}
          <p>{@render inline(line)}</p>
        {/each}
      </blockquote>
    {:else if block.kind === 'table'}
      <div class="wiki-table">
        <table>
          <thead>
            <tr>
              {#each block.header as cell}
                <th scope="col">{@render inline(cell)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each block.rows as row}
              <tr>
                {#each row as cell, column}
                  <td data-etiqueta={plain(block.header[column] ?? [])}>{@render inline(cell)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if block.ordered}
      <ol>
        {#each block.items as item}
          <li>{@render inline(item)}</li>
        {/each}
      </ol>
    {:else}
      <ul>
        {#each block.items as item}
          <li>{@render inline(item)}</li>
        {/each}
      </ul>
    {/if}
  {/each}
</div>
