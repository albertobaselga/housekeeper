# `@casa-clara/web`

SvelteKit + TypeScript: el marco de la aplicación instalable, las capacidades
por papel, el almacén de IndexedDB y `/api/v1`. Es la única puerta por la que
entra una persona.

Se ejecuta desde la raíz del monorepo con pnpm. Los comandos de aquí abajo
llevan `--filter` porque `npm` no vale: esto es un workspace.

## Arrancar

```bash
pnpm --filter @casa-clara/web dev     # http://localhost:5173
```

Sin `DATABASE_URL` arranca en **modo maqueta**: `/login` muestra el selector de
las cinco cuentas sintéticas y el servidor emite una sesión `HttpOnly` en
memoria. Con `DATABASE_URL` esas maquetas **dejan de existir** —lanzan
`FixturesForbiddenError`— y todo se lee de Postgres bajo RLS.

El selector no es una comprobación en tiempo de ejecución: `__FIXTURE_LOGIN__`
es una constante de compilación, así que al construir **la rama entera
desaparece del paquete** salvo que se declare `CASA_CLARA_FIXTURE_LOGIN`. Y un
despliegue que la lleve puesta junto a una base de datos se niega a arrancar
(`scripts/check-deployment-config.mjs`). Son dos cierres distintos a propósito:
el primero hace imposible el descuido, el segundo lo hace ruidoso.

## Comprobaciones

```bash
pnpm --filter @casa-clara/web check           # escalas CSS + svelte-check
pnpm --filter @casa-clara/web test            # unidad e integración (integración pide Postgres)
pnpm --filter @casa-clara/web build
pnpm --filter @casa-clara/web verify:bundle   # exige una build previa
```

`verify:bundle` lee el manifiesto de producción y comprueba tres cosas: que el
grafo inicial de Hoy no pasa de su presupuesto, que el editor de la guía sigue
siendo un trozo cargado por ruta, y que ninguna marca de las cuentas sintéticas
se ha colado en el JavaScript del cliente.

`check` incluye `lint-css-tokens.mjs`, que impide que vuelvan a aparecer valores
sueltos fuera de la escala del sistema de diseño
([docs/ux/sistema-movil.md](../../docs/ux/sistema-movil.md)).

## Fronteras que no se cruzan

- **La autorización es denegar por defecto** y vive en `hooks.server.ts`. Que
  una entrada de menú no se pinte es presentación, nunca protección.
- Los identificadores de papel y capacidad son los del vocabulario compartido de
  `@casa-clara/contracts`. No se inventan aquí.
- Los corpus sintéticos viven **solo** en `src/lib/server/*.server.ts`, para que
  no puedan viajar al cliente.
- IndexedDB posee `criticalSnapshots`, `outbox` y `blobs`. Una entrada de la
  bandeja de salida se borra **únicamente** tras una confirmación explícita del
  servidor: nunca se da por buena una escritura que no se ha reconocido.
- El service worker cachea los recursos versionados y las páginas visitadas, más
  una pantalla de reserva sin conexión.
- **El texto de interfaz no nombra al proyecto.** Sin sesión manda el nombre
  genérico del producto; con sesión, el del hogar. Fuente única:
  `src/lib/app-title.ts`.
