<script lang="ts">
  /*
   * Los doce glifos de texto que había aquí (☀ € ◌ ◇ ▤ ⌕ ✓ □ ☎ + ◈ ⚙) se
   * renderizaban con la fuente del cuerpo, cambiaban de forma en cada
   * plataforma —`☎` salía como emoji en iOS— y varios no comunicaban nada:
   * `◌` para Menú, `□` para Calendario, `◈` para tu cuenta. Son SVG en línea a
   * 20 px, trazo único, sin relleno: la ganancia de reconocibilidad más barata
   * que hay, y la única forma de que el icono signifique lo mismo en los dos
   * teléfonos de la casa.
   *
   * Cada dibujo dice lo que la sección ES, no la letra con la que empieza:
   * Rutinas es una flecha que vuelve (se repiten), Calendario es una rejilla de
   * días, Contrato es un documento firmado y «Tu contraseña» es una llave.
   */
  const paths: Record<string, string> = {
    // Sol: el día.
    today:
      'M12 4.5v-2M12 21.5v-2M19.5 12h2M2.5 12h2M17.3 6.7l1.4-1.4M5.3 18.7l1.4-1.4M17.3 17.3l1.4 1.4M5.3 5.3l1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    // Documento con firma: el acuerdo laboral.
    employment: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h3',
    // Tenedor y cuchillo: lo que se come.
    menu: 'M8 3v7a2 2 0 0 1-4 0V3M6 10v11M16 3c-1.5 1.5-1.5 5 0 6.5V21',
    // Cazuela con tapa: el recetario.
    recipes: 'M4 10h16M5 10v6a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-6M12 4v3M4 13H2M20 13h2',
    // Libro abierto: la guía de la casa.
    wiki: 'M12 6.5C10.5 5 8 4.5 4 5v13c4-.5 6.5 0 8 1.5 1.5-1.5 4-2 8-1.5V5c-4-.5-6.5 0-8 1.5zM12 6.5v13',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4 4',
    // Flecha que vuelve: una rutina es algo que se repite.
    routines: 'M20 12a8 8 0 1 1-2.4-5.7M20 3v4h-4',
    // Rejilla de días con su cabecera.
    calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M9 14h2M14 14h2',
    // Auricular: a quién se llama.
    contacts:
      'M8 3H5a2 2 0 0 0-2 2c0 8.3 6.7 15 15 15a2 2 0 0 0 2-2v-3l-4-2-2 2.5A14 14 0 0 1 9.5 9L12 7z',
    // Cruz: emergencias.
    emergency: 'M12 4v16M4 12h16',
    // Llave: tu contraseña.
    account: 'M14.5 4a5.5 5.5 0 1 0-4 9.3L4 20v0h3v-2h2v-2h1.7l1.8-1.8A5.5 5.5 0 0 0 14.5 4zM15 8.5h.01',
    // Mandos: los ajustes del hogar.
    settings: 'M4 7h16M4 17h16M10 7a2 2 0 1 0 0-.01M16 17a2 2 0 1 0 0-.01'
  };

  let { name }: { name: string } = $props();
</script>

<span class="nav-symbol" aria-hidden="true">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d={paths[name] ?? 'M12 6v12M6 12h12'} />
  </svg>
</span>
