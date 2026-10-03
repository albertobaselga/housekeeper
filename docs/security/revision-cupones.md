# Revisión de seguridad del módulo Cupones

Fecha: 2026-10-03 · Rama `feat/cupones`. Complementa a
[security-baseline.md](security-baseline.md); el diseño está en la spec del
módulo (`docs/superpowers/specs/2026-10-03-modulo-cupones-design.md`, §4, §7 y
§9).

**Estado: parcial.** La revisión ejecutada que pide la spec (§9 y §11, paso 6:
consultas a `pg_policies`, prueba de la empleada, cabeceras de la foto y logs,
cada una con su salida real) está pendiente. Esta página recoge, de momento, lo
que dejó decidido la revisión adversarial de la fase 2 (rondas 1 y 2): lo que
se cerró en código y lo que queda como riesgo residual, con su porqué.

## Cerrado en la fase 2

| Hallazgo | Qué se hizo | Dónde se prueba |
|---|---|---|
| La página de la cartera se guardaba en el dispositivo. El service worker guarda en su caché de páginas toda navegación con éxito que no diga `no-store` (`storable()` de `apps/web/src/service-worker.ts`) y la sirve sin red o ante un 503. El HTML de `/h/<id>/cupones` lleva la cartera entera, códigos y notas incluidos: sin red se enseñaba (D-offline dice «solo con red») y en un móvil compartido se quedaba tras cerrar la sesión. | El `load` de la página responde `cache-control: private, no-store` siempre: con datos, con el 503 y en la demostración. Es la misma razón por la que la foto ya iba con `no-store`. | `apps/web/tests/coupons-page-load.test.ts` |
| La familia no administradora no veía quién guardó ni quién usó un cupón: la RLS de `user_profiles` (0005) solo le enseña su propio perfil. | `app.coupon_people()` (0039): plpgsql, `SECURITY DEFINER`, `row_security = off` dentro y la puerta del papel puesta por ella misma. Devuelve `(membership_id, display_name)` solo a la familia del hogar del contexto, y solo de quien firmó el alta de un cupón o un uso vivo de ese hogar. A cualquier otro papel, sin contexto o con la membresía caducada, cero filas. `EXECUTE` solo para `casa_clara_app`. No se abre `user_profiles`: eso daría también el nombre de la empleada, del apoyo y de quien ya no está. | `packages/db/tests/210_coupons.sql` (familia, olivo, sin contexto, caducada, empleada, segunda empleada, apoyo, acceso puntual y emisor de trabajos) y `apps/web/tests/coupons.integration.test.ts` |
| Una fecha escrita a mano fuera de 2000–2999 tumbaba la cartera entera al leerla. | `CHECK` de rango en `coupons.expires_on` y `coupon_uses.used_on`, el mismo del contrato (`couponDateSchema`). | `packages/db/tests/210_coupons.sql` |
| (Ronda 2, m1.) En GET, la página no tenía segunda reja propia. En SvelteKit 2.70.2, un `GET …/cupones/__data.json?x-sveltekit-invalidated=01` da el layout por válido y no ejecuta su `load`, que es el que responde 403; el de la página sí se ejecuta. La RLS ya le daba a la empleada, al apoyo y al acceso puntual una cartera vacía: no salía nada. | `loadCoupons` mira `can(membership.role, 'coupon.access')` con la membresía que acaba de leer la transacción, y sin la capacidad devuelve la cartera vacía **sin consultar** cupones, usos ni nombres. Ahora la frontera en GET son dos rejas: esta y la RLS. | `apps/web/tests/coupons.integration.test.ts` («a quien no tiene la capacidad ni se le pregunta…»: registra las consultas del cliente; con la reja quitada falla con 2 consultas a `app.coupon*`) |
| (Ronda 2, m3.) El texto del 409 decía «Esa foto ya la subió otra persona de la casa», y no siempre era verdad: también choca un PDF del gasto, y también la misma persona con una membresía anterior (`ownExisting` compara la membresía). Era texto, no seguridad. | «Ese fichero ya lo subió alguien de la casa.», en la ruta y en el cliente. | `apps/web/tests/attachment-upload.test.ts`, `attachment-pipeline.test.ts`, `attachments.integration.test.ts` |
| (Ronda 2, m4, en parte.) Faltaba la prueba de la empleada con sesión de verdad. | `e2e/cupones.dbe2e.ts`: con la sesión de la empleada no hay entrada «Cupones» en la navegación, la página responde **403** con «Esta parte la lleva la familia.» y la ruta de la foto, **404**. La revisión ejecutada completa (consultas a `pg_policies`, cabeceras, registros) sigue pendiente para la fase 6. | `apps/web/e2e/cupones.dbe2e.ts` («la empleada no tiene cartera…») |

## Riesgos residuales aceptados

### R12 en este módulo: lo que sí se queda en el dispositivo

El riesgo de fondo es R12 (BAJA) de
`docs/despliegue/puesta-en-produccion-eg112.md`: cerrar la sesión no borra la
caché del service worker ni IndexedDB. Con la cartera fuera de la caché,
quedan dos cosas de cupones dentro de R12:

- **El HTML de Hoy.** Hoy sí se guarda (es la pantalla que se abre sin red), y
  su asunto `cupones-caducan` lleva el **comercio y la oferta** de los cupones
  que caducan en tres días. **No lleva el código.** En un móvil compartido, la
  siguiente persona que abra Hoy sin red vería esa copia.
- **La bandeja de salida (IndexedDB).** Es del hogar, no de la persona
  (`listOutbox(householdId)`, `performSyncFlush`). Un uso, un descarte o una
  edición hechos sin red se quedan ahí hasta enviarse, y el alta y la edición
  llevan los campos del cupón, **código incluido**. Si en ese dispositivo entra
  después la empleada, su sesión intenta enviarlos, el servidor los rechaza con
  `not_allowed` y su triaje en Hoy enseña «Cupón nuevo de «Comercio»» con
  «Descartar» (revisión de seguridad, m1).

  No se quita el comercio de ese texto: los datos ya están en IndexedDB, así
  que ocultarlo en el triaje no cierra la exposición, y en el caso normal —la
  misma persona en su móvil— es lo que le dice qué cupón no se pudo guardar.
  El arreglo de verdad es de R12: vaciar la caché y la bandeja al cerrar la
  sesión.
- **La autoría dentro de la familia** (revisión de seguridad, ronda 2, m2).
  La bandeja la envía la sesión que esté abierta cuando vuelve la red. Si Marta
  apunta sin red un uso, una anulación o un descarte, cierra la sesión y en ese
  mismo móvil entra Ana, la bandeja sale con la sesión de Ana, y la base firma
  con quien escribe (exige `used_by`, `voided_by` y `discarded_by` = la
  membresía actual): la ficha dirá «Usado el … por Ana». No sale nada de la
  familia, pero la autoría queda mal. Mismo arreglo de R12.

### La administración puede quedarse por SQL con un objeto ajeno y enlazarlo

`storage_objects_write` (0005, `FOR ALL`) tiene como `USING` «propio o
`family_admin`» y como `WITH CHECK` «`created_by` = yo». Así, `family_admin`
puede reescribir por SQL directo el `created_by_membership_id` del tique de la
empleada (comprobado en la revisión: 1 fila) y, después, el comando y el
disparador `coupons_photo_link` lo aceptan como suyo. El `family_member` pasa a
ver el tique y la empleada deja de verlo.

**Ninguna vía de la aplicación** hace UPDATE de `app.storage_objects`: la
frontera de la regla de enlace es el comando (spec §7.1), y el disparador es el
respaldo, como ya dice la cabecera de la 0039. Pendiente para otra migración: un
disparador que congele `created_by_membership_id` en `app.storage_objects`.

### El 409 de la subida confirma que esos bytes ya están en la casa

Subir exactamente los mismos bytes que un adjunto ya guardado en el hogar
responde 409 `attachment_duplicate` (spec §7.2). Cualquier miembro puede subir
adjuntos, incluidos la empleada y el acceso puntual, así que la respuesta
confirma que alguien de la casa subió ese fichero. Para aprovecharlo hace falta
tener ya el fichero exacto, reencodado: el riesgo es despreciable. Antes del
módulo era un 500 con el mismo valor como oráculo. Aceptado.

### El EXIF y el GPS solo se quitan en el navegador

`prepareAttachment({ alwaysReencode: true })` redibuja siempre la foto del
cupón y no sube nunca el original. Un cliente que no sea la aplicación, o un
POST directo a `/api/v1/households/<id>/attachments`, puede subir el original
con su posición GPS, y después lo verá toda la familia. Es lo que decide la
spec (§9): la audiencia es la familia y quien sube expone sus propios datos.
Aceptado.

### La auditoría copia el código

`audit_events` guarda la fila entera del cupón, código incluido, y la lee
`family_admin`. Aceptable porque la administración ya es audiencia del módulo
(spec §9). La revisión comprobó que `family_member` no ve los eventos que firma
otra persona y que la empleada, el apoyo y el acceso puntual no ven ninguno.
