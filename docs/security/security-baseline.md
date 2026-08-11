# Baseline de seguridad y privacidad

Este baseline aplica a local y staging sintético. No constituye autorización para producción.

## Fronteras y activos

- **Críticos:** expediente laboral, saldos, liquidaciones, pagos, auditoría, información de menores, alergias, autorizaciones y adjuntos.
- **Fronteras:** navegador/service worker, Caddy, web/API, worker, Postgres, Storage y —cuando existe— escáner de archivos. **Correo, ninguno**: la salida SMTP se retiró en la migración 0029 y con ella esa frontera entera.
- **Amenazas prioritarias:** cruce de hogares, elevación de rol, sesión revocada aún válida, URL de objeto reutilizable, replay de outbox, edición retroactiva, archivo malicioso y filtrado de PII por logs.

## Controles obligatorios

1. RLS `default deny` en toda tabla multi-tenant y prueba negativa para los cinco roles.
2. Las claves administrativas nunca llegan al navegador. Operaciones privilegiadas pasan por funciones/API con autorización explícita.
3. Membresías caducadas y revocadas se comprueban en cada acceso; la revocación invalida sesiones activas.
4. Libros, liquidaciones cerradas y auditoría son append-only. Las correcciones son nuevos asientos.
5. Los adjuntos se validan por tamaño y por su **firma real** (los bytes mágicos, no el tipo que declare el navegador), se guardan en un bucket privado con clave determinista y **nunca** se publican: se sirven proxeados por una ruta que comprueba sesión y pertenencia bajo RLS, con `nosniff` y `Content-Security-Policy: sandbox`. El análisis antivirus es **opcional y hoy no está activo** en el despliegue de producción; el riesgo asumido y cómo reactivarlo están en [adjuntos-sin-antivirus.md](adjuntos-sin-antivirus.md).
6. Idempotency key por escritura offline, vinculada a hogar, actor y operación. Los conflictos de jornada requieren resolución humana.
7. Caddy añade hardening de transporte; la aplicación emite una CSP con nonce/hash compatible con su renderizado.
8. Logs con allowlist y redacción; nunca tokens, contraseñas, contenido, consultas, diagnósticos médicos o metadatos EXIF.
9. Staging contiene solo fixtures sintéticos y establece `ALLOW_SYNTHETIC_DATA_ONLY=true`. Producción **no la define**, y esa afirmación se sostiene sola: un despliegue que la lleve con `VERCEL_ENV=production` no arranca, y la build de producción la rechaza por existir. Comprobable desde fuera en `/api/health` (`"synthetic": false`). Ningún código puede distinguir un dato real de uno inventado; lo que este control garantiza es que la etiqueta no puede mentir, no que la base esté limpia. Ver `docs/adr/0003-configuracion-indivisible-y-cuentas-sinteticas.md`.
10. El camino de acceso por cuentas sintéticas no existe en el paquete de producción: `__FIXTURE_LOGIN__` lo excluye en tiempo de compilación y la build lo comprueba sobre su propia salida. Comprobable en `/api/health` (`"fixtureLogin": false`).
11. Base de datos e identidad son indivisibles: con `DATABASE_URL` configurada y `DATABASE_AUTH_URL`, `BETTER_AUTH_SECRET` o `BETTER_AUTH_URL` ausentes, la aplicación no sirve y nombra lo que falta.
12. Los enlaces `wa.me` requieren gesto del usuario y no incluyen información sensible en el texto o la URL.

## Retención y privacidad

- Las reglas de retención serán datos versionados y no constantes de código.
- Las compensaciones no caducan según la adaptación aprobada.
- Las lecturas se agregan sin identidad y las búsquedas fallidas permanecen dentro del hogar bajo RLS.
- El recibo informal debe incluir que no es un documento oficial.
- Export y traspaso generan manifest y hash; el acceso posterior al fin de la relación usa una entrega temporal auditada.
