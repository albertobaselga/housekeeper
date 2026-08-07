BEGIN;

-- P1 de la revisión adversarial: la 0009 concedió EXECUTE sobre
-- app_private.ics_feed_events a casa_clara_app, pero el rol nunca tuvo USAGE
-- sobre el esquema app_private (la 0001 lo reservó al worker), así que toda
-- petición al feed moría con "permission denied for schema app_private".
-- USAGE no abre ninguna tabla: los grants de tabla y las políticas RLS siguen
-- siendo la única puerta.
GRANT USAGE ON SCHEMA app_private TO casa_clara_app;

COMMIT;
