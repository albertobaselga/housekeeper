BEGIN;

-- Retención de datos de descubrimiento (hueco de la revisión adversarial):
-- las lecturas agregadas solo alimentan ventanas de 30 días y los huecos de
-- búsqueda pierden valor pasados unos meses. El worker ejecuta la poda con
-- esta función de superficie mínima; nada más obtiene DELETE sobre las tablas.
CREATE FUNCTION app_private.prune_discovery_data(
  reads_keep_days integer DEFAULT 45,
  gaps_keep_days integer DEFAULT 180
)
RETURNS TABLE (pruned_reads bigint, pruned_gaps bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  reads_count bigint;
  gaps_count bigint;
BEGIN
  IF reads_keep_days < 30 OR gaps_keep_days < 30 THEN
    RAISE EXCEPTION 'la retención mínima es de 30 días' USING ERRCODE = '22023';
  END IF;
  DELETE FROM app.wiki_page_reads
   WHERE read_on < current_date - reads_keep_days;
  GET DIAGNOSTICS reads_count = ROW_COUNT;
  DELETE FROM app.search_gap_events
   WHERE occurred_on < current_date - gaps_keep_days;
  GET DIAGNOSTICS gaps_count = ROW_COUNT;
  RETURN QUERY SELECT reads_count, gaps_count;
END
$$;

REVOKE ALL ON FUNCTION app_private.prune_discovery_data(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.prune_discovery_data(integer, integer) TO casa_clara_worker;

COMMIT;
