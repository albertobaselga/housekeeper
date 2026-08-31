const startedAt = Date.now();

export interface WebHealth {
  status: 'ok';
  uptimeSeconds: number;
  checkedAt: string;
  /**
   * Este despliegue se declara solo-sintético (`ALLOW_SYNTHETIC_DATA_ONLY`).
   * En producción tiene que valer `false`, y ahora eso se comprueba con un
   * `curl` en vez de con un inicio de sesión y un vistazo al banner.
   */
  synthetic: boolean;
  /**
   * El paquete lleva dentro el selector de cuentas sintéticas
   * (`__FIXTURE_LOGIN__`). En producción tiene que valer `false`: convierte la
   * auditoría «grep sobre la función desplegada» en una comprobación que puede
   * hacer cualquiera, desde fuera, sin acceso a la plataforma.
   */
  fixtureLogin: boolean;
}

export function readWebHealth(now = Date.now(), syntheticOnly = false): WebHealth {
  return {
    status: 'ok',
    uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1_000)),
    checkedAt: new Date(now).toISOString(),
    synthetic: syntheticOnly,
    fixtureLogin: __FIXTURE_LOGIN__
  };
}

export function renderWebMetrics(now = Date.now()): string {
  const memory = process.memoryUsage();
  const uptime = Math.max(0, (now - startedAt) / 1_000);
  return [
    '# HELP housekeeper_web_up Whether this web process is serving requests.',
    '# TYPE housekeeper_web_up gauge',
    'housekeeper_web_up 1',
    '# HELP housekeeper_web_uptime_seconds Process uptime in seconds.',
    '# TYPE housekeeper_web_uptime_seconds gauge',
    `housekeeper_web_uptime_seconds ${uptime.toFixed(3)}`,
    '# HELP housekeeper_web_memory_bytes Process memory without request or user labels.',
    '# TYPE housekeeper_web_memory_bytes gauge',
    `housekeeper_web_memory_bytes{kind="rss"} ${memory.rss}`,
    `housekeeper_web_memory_bytes{kind="heap_used"} ${memory.heapUsed}`,
    ''
  ].join('\n');
}
