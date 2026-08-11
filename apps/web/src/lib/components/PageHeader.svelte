<script lang="ts">
  import type { Snippet } from 'svelte';

  /*
   * La cabecera de página: UNA línea de 24 px que dice el estado.
   *
   * `eyebrow` y `description` siguen en la firma —las quince llamadas actuales
   * no se rompen— pero por debajo de 600 px no se pintan: el eyebrow era
   * decorativo en seis de ocho pantallas (en Calendario repetía literalmente la
   * cabecera del mini-calendario dos filas más abajo) y la descripción es copy
   * de bienvenida servido en cada visita a alguien que abre esta pantalla todos
   * los días. La descripción vive ahora en el estado vacío, que es donde una
   * explicación hace falta y donde sobra sitio.
   *
   * `support` es la línea de 13 px que sí sobrevive: el nombre del hogar en
   * Hoy, el apartado en una nota de la Guía, el periodo en Contrato. Es dato,
   * no bienvenida.
   *
   * El `h1` sigue siendo único y descriptivo: cambia su TEXTO —pasa a decir el
   * estado en vez de repetir lo que ya dice la pestaña activa de la barra
   * inferior en 6 de 8 pantallas—, no su papel.
   */
  let {
    eyebrow,
    title,
    support,
    description,
    actions
  }: {
    eyebrow: string;
    title: string;
    support?: string;
    description?: string;
    actions?: Snippet;
  } = $props();
</script>

<header class="page-header">
  <div>
    <p class="eyebrow">{eyebrow}</p>
    <h1>{title}</h1>
    {#if support}<p class="page-support">{support}</p>{/if}
    {#if description}<p class="page-description">{description}</p>{/if}
  </div>
  {#if actions}<div class="page-actions">{@render actions()}</div>{/if}
</header>
