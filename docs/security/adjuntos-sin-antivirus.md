# Adjuntos sin antivirus: riesgo asumido y cómo volver a encenderlo

Este documento existe porque una decisión de seguridad no puede vivir solo en el
código. Dice **qué se quitó**, **qué se puso en su lugar**, **qué riesgo queda
abierto** y **qué hay que hacer** el día que haya dónde ejecutar un escáner.

## 1. Qué pasaba y qué se decidió

El despliegue real es **Vercel + Supabase**: no hay ningún host propio donde
correr un demonio. ClamAV es un demonio con una base de firmas de cientos de
megabytes; no cabe en una función serverless, ni en Supabase, ni en el plan de
Vercel. Mientras el escáner fue **obligatorio**, adjuntar un justificante y
mirar uno ya guardado respondían **503** en producción. La funcionalidad no
estaba degradada: estaba muerta, y con ella el papel del justificante en la
relación laboral —quien pone un gasto no podía probarlo, quien lo aprueba no
podía mirarlo—.

Decisión del propietario, literal:

> «Obvia el antivirus, que se pueda subir un fichero directamente o hacerle una
> foto si estás en el móvil.»

La alternativa era pagar un host aparte (7–15 USD/mes) solo para el antivirus, o
mandar cada documento del hogar a un servicio de escaneo de terceros. Para un
hogar con una empleada y un puñado de tickets al mes, ninguna de las dos se
sostiene.

## 2. Qué se quitó, exactamente

El escáner **no se ha borrado ni comentado**: ha dejado de ser obligatorio.

- `AttachmentDependencies.scan` es ahora un miembro **opcional**
  (`apps/web/src/lib/server/attachments.server.ts`).
- `createAttachmentDependencies` construye el escáner **solo si hay
  `CLAMAV_HOST`** (`apps/web/src/lib/server/attachment-deps.server.ts`). Lo que
  antes anulaba el paquete entero de adjuntos ahora solo omite el escaneo.
- El cliente INSTREAM de clamd (`scanWithClamAv`) y la pasarela con TLS y token
  de `infra/clamav` siguen en el repositorio, con sus pruebas, funcionando.

Cuando **sí** hay escáner, el comportamiento es exactamente el de antes:
veredicto `infected` → 422 y no se sube ni se registra nada; escáner caído o con
respuesta ininteligible → 503 honesto. **Nunca** se asume «limpio».

## 3. Qué queda en pie (y qué se ha reforzado)

| Garantía | Estado |
| --- | --- |
| Límite de tamaño (10 MiB, y ~4 MB efectivos en Vercel) | Igual que antes |
| Lista blanca de tipos: JPEG, PNG, WebP, PDF | Igual que antes |
| **Comprobación de la firma real del fichero** | **Reforzada** |
| sha-256 del contenido y clave determinista por hogar | Igual que antes |
| Bucket privado; ningún objeto público ni URL firmada | Igual que antes |
| Lectura tras comprobar sesión y pertenencia bajo RLS | Igual que antes |
| 404 que no distingue «no existe» de «no te toca» | Igual que antes |
| Alta en `storage_objects` y PUT en la misma transacción | Igual que antes |
| Fallo honesto: 503 con motivo, nunca un silencio | Igual que antes |
| **`nosniff` y CSP `sandbox` al servir el fichero** | **Nuevo** |

Los dos refuerzos merecen detalle, porque son los que ocupan el hueco:

**El tipo real manda.** Antes se comprobaba que la firma mágica *coincidiera*
con el tipo declarado, pero el que se guardaba y se servía era el **declarado**.
Ahora `detectMediaType()` deduce el tipo de los bytes y **ese** es el que se
registra en `app.storage_objects.media_type` y el que sale en el `content-type`
de la lectura. Un ejecutable renombrado a `.jpg` no entra, y lo que declare el
navegador no puede llegar nunca a una cabecera de respuesta.

**El fichero se sirve desactivado.** Un justificante es contenido de terceros
servido desde nuestro propio origen. `X-Content-Type-Options: nosniff` impide
que el navegador reinterprete los bytes como otra cosa, y
`Content-Security-Policy: default-src 'none'; sandbox` deja el documento sin
origen: un PDF con JavaScript dentro no puede leer la sesión de la casa ni
llamar a la API.

## 4. El riesgo que se asume

**Un fichero con malware puede quedar guardado en el bucket del hogar.** Las
barreras de arriba comprueban la *forma* del fichero, no su *contenido*: un JPEG
o un PDF perfectamente válidos pueden llevar dentro un exploit dirigido al
visor de quien los abra.

Quién puede subirlo: **solo una persona con sesión iniciada y membresía activa
en el hogar** —la familia, la empleada o un apoyo—. No hay subida anónima ni
desde fuera del hogar, así que esto no es una puerta abierta a internet: es
confianza en las personas del hogar y en que sus dispositivos no estén
comprometidos.

A quién puede alcanzar:

1. **A quien abra el justificante**, si su navegador o su visor de PDF tienen
   una vulnerabilidad sin parchear. Es el riesgo real, y el `sandbox` lo reduce
   pero no lo elimina: un fallo en el descodificador de imágenes del navegador
   no pasa por la CSP.
2. **A quien descargue el fichero y lo abra fuera del navegador**, donde ya no
   hay CSP que valga.
3. **Al servidor, no.** Los bytes no se ejecutan, no se interpretan, no se pasan
   a ninguna herramienta externa: se calcula su sha-256, se miran sus primeros
   bytes y se mandan a Storage.

Lo que **no** cambia el riesgo: los ficheros nunca son públicos, así que un
fichero malicioso no se puede usar para servir malware a terceros desde nuestro
dominio ni para un ataque de descarga dirigida.

**Mitigación operativa disponible sin código:** cada objeto queda registrado con
su sha-256 en `app.storage_objects`. Si algún día hace falta comprobar un
adjunto concreto, ese hash se puede consultar contra un servicio de reputación
sin mover el fichero de sitio, y `pnpm backup:full` baja todos los adjuntos para
pasarles un escáner en el portátil.

## 5. Cómo volver a encender el escaneo

**No hay que tocar código.** El día que exista un host con clamd —un servidor
propio, un contenedor en Fly.io, el mismo host del worker—, basta con:

1. Desplegar la pasarela de `infra/clamav` delante de clamd (TLS y token
   compartido; clamd no tiene autenticación propia y publicar su puerto en
   abierto sería regalar el antivirus a internet). El procedimiento completo
   está en `docs/despliegue/runbook-despliegue.md`, §4.
2. Definir en el proyecto de Vercel:

   ```
   CLAMAV_HOST=antivirus.tu-dominio.es
   CLAMAV_PORT=3311
   CLAMAV_TLS=true
   CLAMAV_TOKEN=<el mismo valor que CLAMAV_GATEWAY_TOKEN del host>
   ```

3. Redesplegar. `createAttachmentDependencies` vuelve a construir `scan`, y la
   tubería vuelve a escanear cada subida: positivo → 422, escáner caído → 503.

Para verificar que está activo: subir el fichero de prueba **EICAR** (la cadena
estándar inofensiva que todo antivirus detecta) debe responder 422. Si responde
201, el escáner no se está construyendo: repasar `CLAMAV_HOST`.

**Los adjuntos subidos mientras no hubo escáner no se escanean solos.** Si se
quiere revisarlos retroactivamente: `pnpm backup:full` los baja todos a disco y
`clamscan -r` sobre ese directorio da el veredicto sin tocar producción.

## 6. Registro de la decisión

| Campo | Valor |
| --- | --- |
| Decisión | Adjuntos sin escaneo antivirus en el despliegue Vercel + Supabase |
| Quién | El propietario del hogar, explícitamente |
| Cuándo | Agosto de 2026 |
| Alternativas descartadas | Host aparte solo para ClamAV (coste mensual recurrente); servicio de escaneo de terceros (los documentos del hogar saldrían a un tercero) |
| Revisión | Cuando exista un host propio por otro motivo, o si el hogar empieza a recibir adjuntos de personas ajenas |
