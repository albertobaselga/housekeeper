# Runbook: incidente de seguridad o privacidad

## Cuándo activarlo

Activar ante acceso entre hogares, rol excesivo, sesión que sobrevive a revocación, exposición de secreto, objeto público, modificación retroactiva, malware en un adjunto, dato real en staging o PII en logs/artefactos.

| Severidad | Ejemplo | Respuesta |
|---|---|---|
| P0 | Exfiltración activa, clave administrativa pública o corrupción de libros. | Contención inmediata; se detienen escrituras y despliegues. |
| P1 | RLS eludible, sesión revocada válida o backup no restaurable. | Bloqueo de releases y corrección prioritaria. |
| P2 | Hardening incompleto sin explotación ni exposición. | Propietario y fecha; no se oculta en un backlog genérico. |

## 1. Contener sin destruir evidencia

1. Nombrar responsable del incidente y abrir una línea temporal UTC.
2. Deshabilitar la función o aislar `web`/`worker` si siguen propagando daño. Mantener Postgres y Storage accesibles solo al equipo de respuesta.
3. Revocar la credencial o membresía concreta e invalidar sesiones activas. Si el alcance es desconocido, rotar por clase: sesión, DB, S3, SMTP y observabilidad.
4. Preservar logs operativos, auditoría append-only, versión de imágenes y configuración efectiva. No editar ni “limpiar” filas antes de capturar evidencia.
5. Si aparecen datos reales en staging, detenerlo, restringir volúmenes y tratarlo como incidente de privacidad aunque el dato parezca inocuo.

## 2. Determinar alcance

- Primer y último acceso conocido, hogares/objetos afectados y acciones ejecutadas.
- Diferenciar `AuditLog` de logs técnicos; correlacionar por ID opaco, no copiar contenido personal.
- Comprobar RLS, URLs firmadas, cachés PWA, outbox, backups, artefactos CI y proveedores.
- Para malware, conservar hash y metadatos mínimos; el binario permanece aislado, nunca se descarga a un equipo personal.

## 3. Erradicar y recuperar

1. Corregir primero con test de regresión que reproduzca el fallo.
2. Rotar secretos desde su gestor y reiniciar consumidores. No registrar el nuevo valor en comandos, tickets o Git.
3. Reaplicar migraciones/políticas y ejecutar la matriz RLS completa.
4. Restaurar a un entorno aislado si hay sospecha de corrupción; comparar libros y auditoría antes de promover datos.
5. Invalidar caches/snapshots que contuvieran datos ya no autorizados y probar que un cliente offline no recupera acceso.
6. Reabrir tráfico gradualmente; observar denegaciones, errores y outbox sin inspeccionar comportamiento individual.

## 4. Comunicación y cierre

- La familia y la empleada reciben hechos, impacto, medidas y acciones requeridas en lenguaje claro.
- La necesidad y plazo de notificación legal se decide con asesoría de privacidad según datos y alcance; el equipo técnico no la presume ni la descarta.
- El postmortem no incluye PII y documenta causa, barreras fallidas, tiempo de detección/contención y controles nuevos.
- El incidente se cierra solo con pruebas verdes, secretos rotados, evidencia preservada y responsable de seguimiento.

## Reglas permanentes

- No usar datos reales en local o staging.
- No pegar secretos ni dumps en chats, issues o artefactos.
- No usar analítica/replay de terceros.
- No enviar datos sensibles por `wa.me`; solo se permite un enlace iniciado por el usuario hacia la pantalla autenticada.
