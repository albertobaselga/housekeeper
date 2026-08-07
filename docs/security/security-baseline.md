# Baseline de seguridad y privacidad

Este baseline aplica a local y staging sintético. No constituye autorización para producción.

## Fronteras y activos

- **Críticos:** expediente laboral, saldos, liquidaciones, pagos, auditoría, información de menores, alergias, autorizaciones y adjuntos.
- **Fronteras:** navegador/service worker, Caddy, web/API, worker, Postgres, Storage, correo sintético y escáner de archivos.
- **Amenazas prioritarias:** cruce de hogares, elevación de rol, sesión revocada aún válida, URL de objeto reutilizable, replay de outbox, edición retroactiva, archivo malicioso y filtrado de PII por logs.

## Controles obligatorios

1. RLS `default deny` en toda tabla multi-tenant y prueba negativa para los cinco roles.
2. Las claves administrativas nunca llegan al navegador. Operaciones privilegiadas pasan por funciones/API con autorización explícita.
3. Membresías caducadas y revocadas se comprueban en cada acceso; la revocación invalida sesiones activas.
4. Libros, liquidaciones cerradas y auditoría son append-only. Las correcciones son nuevos asientos.
5. Adjuntos entran en cuarentena, se validan por tipo/tamaño, se analizan con ClamAV y solo entonces se publican mediante URL corta y firmada.
6. Idempotency key por escritura offline, vinculada a hogar, actor y operación. Los conflictos de jornada requieren resolución humana.
7. Caddy añade hardening de transporte; la aplicación emite una CSP con nonce/hash compatible con su renderizado.
8. Logs con allowlist y redacción; nunca tokens, contraseñas, contenido, consultas, diagnósticos médicos o metadatos EXIF.
9. Staging contiene solo fixtures sintéticos y establece `ALLOW_SYNTHETIC_DATA_ONLY=true`.
10. Los enlaces `wa.me` requieren gesto del usuario y no incluyen información sensible en el texto o la URL.

## Retención y privacidad

- Las reglas de retención serán datos versionados y no constantes de código.
- Las compensaciones no caducan según la adaptación aprobada.
- Las lecturas se agregan sin identidad y las búsquedas fallidas permanecen dentro del hogar bajo RLS.
- El recibo informal debe incluir que no es un documento oficial.
- Export y traspaso generan manifest y hash; el acceso posterior al fin de la relación usa una entrega temporal auditada.
