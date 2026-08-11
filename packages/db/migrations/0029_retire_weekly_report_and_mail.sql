BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Se retiran dos cosas que la aplicación prometía y no podía cumplir: el parte
-- semanal de días trabajados y los avisos por correo.
--
-- ## 1. El parte semanal
--
-- La empleada enviaba una semana de días trabajados y, si nadie decía nada en
-- tres días, el parte se CONFIRMABA SOLO (`app_private.autoconfirm_weekly_report`
-- de la 0006, disparada por el trabajo `time_report.autoconfirm`). Un plazo con
-- consecuencia sobre el expediente laboral corriendo sin que ninguna persona lo
-- vigile ya sería discutible; lo que lo hacía insostenible es que el comando
-- para CONFIRMAR o DISPUTAR el parte nunca llegó a existir. La familia no tenía
-- forma de intervenir dentro del plazo: el silencio no era una decisión, era la
-- única salida. El propietario retira la pieza entera.
--
-- ## 2. Qué se hace con las filas que ya existen
--
-- **Se conservan.** Un parte enviado es historia laboral: dice qué días declaró
-- haber trabajado una persona, quién lo confirmó y cuándo. En una casa donde el
-- expediente es append-only por diseño, borrar eso no es limpieza, es destruir
-- la prueba de una relación de trabajo real. Además `app.extra_work_events`
-- referencia partes por `report_id`, y `app.audit_events` guarda ya el rastro de
-- cada cambio sobre estas dos tablas: retirarlas dejaría auditoría apuntando a
-- tablas inexistentes y jornadas extra sin la semana a la que pertenecieron.
--
-- Para que no queden «tablas que ya no significan nada», el significado se
-- escribe en la propia base y se hace cumplir:
--
--   · La aplicación (`casa_clara_app`) pierde INSERT/UPDATE/DELETE sobre las dos
--     tablas, y las políticas RLS de escritura desaparecen. Lo que queda es
--     lectura, para todos los roles que ya la tenían.
--   · Un COMMENT en cada tabla dice qué son ahora y dónde se leen.
--
-- No se añade disparador de rechazo: la administración de la base —una
-- corrección puntual, una restauración, la carga de una fixture con historia—
-- debe seguir pudiendo escribir. Lo que se cierra es el camino de la
-- aplicación, que es el que prometía un proceso que ya no existe.
--
-- **Dónde se leen.** En un único sitio, y sigue siendo el de siempre: el ZIP que
-- la empleada se descarga de su propio expediente, fichero
-- `partes-semanales.csv` (apps/web/src/lib/server/employment-export.server.ts).
-- Ninguna pantalla los enseña ya.
--
-- ## 3. Los avisos por correo
--
-- No hay canal de correo y no va a haberlo: el canal es la aplicación. Se
-- retiran los dos trabajos que solo sabían mandar correo
-- (`notification.settlement_due` y `notification.routine_due`) y la función de
-- alcance mínimo que sacaba direcciones de la base para dárselas al remitente.
-- Hasta que existan las notificaciones al móvil, los dos avisos quedan sin
-- canal; está escrito en docs/notificaciones.md.
--
-- `app.user_profiles.email` se queda: es la dirección de la cuenta, la escribe
-- el alta del hogar y no es infraestructura de correo. Lo que se va es la
-- función que la exportaba fuera de la base.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── La cola: lo que estuviera encolado de los tres tipos retirados ───────────
--
-- No se borran filas: `app_private.enforce_job_transition` (0004) prohíbe el
-- DELETE porque la cola es rastro de auditoría. La transición legal desde
-- `queued` es a `dead`, que es exactamente lo que son: trabajos que nadie va a
-- ejecutar porque su manejador ya no existe. Sin esto, la primera pasada del
-- vaciador los reclamaría, fallaría por tipo desconocido y los gastaría a
-- reintentos hasta morir igual, pero ensuciando el log por el camino.
UPDATE app_private.job_queue
   SET status = 'dead',
       last_error = 'tipo de trabajo retirado en la migración 0029 (parte semanal y avisos por correo)'
 WHERE status = 'queued'
   AND job_type IN (
     'time_report.autoconfirm',
     'notification.settlement_due',
     'notification.routine_due'
   );

-- ── Las funciones definer que sostenían lo retirado ──────────────────────────

-- Auto-confirmación del parte semanal (0006). Sin ella no hay plazo que corra.
DROP FUNCTION IF EXISTS app_private.autoconfirm_weekly_report(uuid, uuid);

-- Estado del aviso de liquidación (0006). Su único consumidor era el manejador
-- que mandaba el correo; devolvía además `employee_email` y `admin_emails`, o
-- sea, direcciones personales saliendo de la base hacia un servidor SMTP. Sin
-- correo no tiene lector, y una función definer sin lector es superficie
-- expuesta a cambio de nada. Las notificaciones al móvil necesitarán otra cosa
-- (suscripciones de dispositivo), no esta.
DROP FUNCTION IF EXISTS app_private.settlement_reminder_state(uuid, uuid);

-- ── El parte semanal pasa a histórico de solo lectura ────────────────────────

DROP POLICY IF EXISTS weekly_reports_admin_all ON app.weekly_time_reports;
DROP POLICY IF EXISTS weekly_reports_employee_insert ON app.weekly_time_reports;
DROP POLICY IF EXISTS weekly_reports_employee_update ON app.weekly_time_reports;

DROP POLICY IF EXISTS time_entries_admin_all ON app.time_entries;
DROP POLICY IF EXISTS time_entries_employee_all ON app.time_entries;

REVOKE INSERT, UPDATE, DELETE ON app.weekly_time_reports FROM casa_clara_app;
REVOKE INSERT, UPDATE, DELETE ON app.time_entries FROM casa_clara_app;

COMMENT ON TABLE app.weekly_time_reports IS
  'Histórico cerrado del parte semanal, retirado en la migración 0029. Solo '
  'lectura para la aplicación: no se crean partes nuevos ni se confirman los '
  'existentes. Se leen en el ZIP del expediente de la empleada '
  '(partes-semanales.csv).';

COMMENT ON TABLE app.time_entries IS
  'Días trabajados de los partes semanales históricos (ver '
  'app.weekly_time_reports). Solo lectura para la aplicación desde la 0029.';

COMMIT;
