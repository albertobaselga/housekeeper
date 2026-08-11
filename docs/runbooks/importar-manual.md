# Runbook: importar el manual de convivencia (Ola A)

Vuelca el «Manual de convivencia y operaciones v0.1» a un hogar de la app:
la Guía de la casa completa (7 apartados, ~52 notas), las rutinas de
«Rutinas generales», el contacto real del Anexo G y la plantilla de menú del
Anexo D. Todo idempotente: repetir el comando no duplica nada.

## Comando único

```bash
DATABASE_URL='postgresql://casa_admin@127.0.0.1:54329/casaclara_docs' \
  pnpm --filter @casa-clara/db manual:import -- \
  --household 30000000-0000-4000-8000-000000000001
```

- `DATABASE_URL`: rol propietario de las migraciones (o admin del cluster);
  el importador y la siembra usan `set local row_security = off`, igual que
  las fixtures. El uuid de ejemplo es el hogar demo `casa-clara`.
- `--household`: hogar destino. El actor se resuelve solo (primer
  `family_admin` activo); `--membership <uuid>` lo fija a mano.
- `--dry-run`: ensaya TODO (importación y siembra) con rollback y informa de
  lo que haría. El comando real ya ejecuta siempre un dry-run del corpus
  antes de escribir: un corpus inválido aborta sin tocar la base.
- `--docx <ruta>`: regenera el corpus desde el Word antes de importar. Sin
  esta opción se usa el corpus commiteado en `packages/db/content/manual`
  (el `.docx` no se versiona en el repo).

Contra la demo (`casaclara_docs`, puerto 4381) conviene la pasada de ensayo
primero y revisar el informe:

```bash
DATABASE_URL='postgresql://casa_admin@127.0.0.1:54329/casaclara_docs' \
  pnpm --filter @casa-clara/db manual:import -- \
  --household 30000000-0000-4000-8000-000000000001 --dry-run
```

## Qué crea exactamente

| Pieza | Contenido | Estado |
|---|---|---|
| Guía de la casa | 7 apartados en el orden del manual; 52 notas (44 publicadas y 8 sin publicar por conservar «Pendiente de completar por la familia»); fijadas: Principios generales, inicio y cierre de jornada, y el índice de pendientes | idempotente por hash de contenido |
| Índice «Pendientes de completar» | nota sin publicar y fijada, con enlace a cada nota con huecos y a los pendientes que viven en la app (contactos, comensales, recetas, acuerdos) | se regenera con el corpus |
| Rutinas | 2 diarias de la empleada (rutina diaria, ventilación), 1 semanal familiar (concretar plan semanal), 1 quincenal de toda la casa (compra personal, semanal cada 2), 1 mensual familiar (plan periódico); cada una con «Ver ficha: …» | upsert por id determinista; `next_due_hint` solo se fija al crear |
| Contactos | «Emergencias Comunidad de Madrid» (112), tipo emergencia, destacado (aparece en Emergencias y en el paquete offline). Las demás filas del Anexo G son placeholders y NO se siembran | upsert por id determinista |
| Menú | plantilla «Semana tipo del manual (pendiente)» con 14 huecos de texto libre (comida y cena × 7 días) sobre el primer grupo de comensales vivo; aplicable sobre una semana vacía | upsert por id determinista |
| Recetario | **0 recetas**: el Anexo D llegó íntegramente «Pendiente de completar por la familia» | — |

No se importan: portada, índice del Word, «Ruta de consulta», control de
versiones (lo sustituye el historial de revisiones de la Guía) ni los
Anexos G/H/I/J (contactos → módulo Contactos; lista personal → Ola B;
registro de incidencias → descartado por decisión del propietario).

## Después de importar

1. La familia vacía «Pendientes de completar» desde la Guía y publica cada
   nota con un toque.
2. Restricciones por comensal, contactos restantes y recetas se dan de alta
   en sus módulos (Comida, Contactos, Recetario).
3. Si el Word cambia (v0.2…), repetir el comando con `--docx`: las notas con
   contenido nuevo ganan una revisión; las intactas se omiten.

## Verificación

- Suite: `TEST_DATABASE_URL=postgresql://… pnpm --filter @casa-clara/db test:import`
  (corpus real validado + importación + siembra, 17 casos).
- Visual: portada de la Guía con los 7 apartados y las fijadas, una ficha
  con tabla (p. ej. «Rutina diaria de referencia»), el índice de pendientes
  como borrador solo para la familia, las rutinas en Rutinas, el 112 en
  Emergencias y la plantilla en Menú → Semanas plantilla.
