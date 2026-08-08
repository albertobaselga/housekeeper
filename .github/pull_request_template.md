## Qué cambia y por qué

<!-- Una frase. Si hace falta un párrafo, dilo en el párrafo. -->

## Cómo se ha comprobado

<!-- Comandos ejecutados y su resultado. «Pasa el CI» no es una comprobación:
     el CI lo lee cualquiera. Aquí va lo que has visto tú. -->

- [ ] `pnpm lint && pnpm typecheck && pnpm build`
- [ ] `pnpm test:unit`
- [ ] Suites con Postgres afectadas (`test:db`, `test:rls`, integración, `test:e2e:db`)
- [ ] No aplica: <!-- razona por qué -->

## Comprobaciones

- [ ] **Ninguna batería nueva se queda sin job.** Si has añadido un fichero de
      spec, hay un job de `ci.yml` que lo ejecuta y `suite-coverage` está verde.
      Relajar `assert-suite-coverage.py` no es una opción.
- [ ] **Datos sintéticos.** Sin nombres, correos, teléfonos, direcciones ni
      datos laborales reales, ni en código, ni en fixtures, ni en capturas.
- [ ] **Sin secretos.** Ni en el diff ni en los ficheros de ejemplo.
- [ ] **RLS.** Si tocas SQL o cargadores de servidor, la matriz negativa
      (`pnpm test:rls`) sigue en verde y el cambio no introduce una vía que
      esquive el aislamiento por hogar.
- [ ] **Migraciones.** Si añades una, `pnpm db:migrate` dos veces seguidas no
      produce cambios, y no se ha reordenado ni reescrito ninguna existente.
- [ ] **Presupuestos.** `verify:bundle` y Lighthouse siguen pasando si tocas la
      pantalla de Hoy o el grafo de carga inicial.

## Riesgos y qué queda pendiente

<!-- Lo que sabes que no cubre este PR. Escribirlo aquí es barato; descubrirlo
     en producción, no. -->
