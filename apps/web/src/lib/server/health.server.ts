const startedAt = Date.now();

export interface WebHealth {
  status: 'ok';
  uptimeSeconds: number;
  checkedAt: string;
}

export function readWebHealth(now = Date.now()): WebHealth {
  return {
    status: 'ok',
    uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1_000)),
    checkedAt: new Date(now).toISOString()
  };
}

export function renderWebMetrics(now = Date.now()): string {
  const memory = process.memoryUsage();
  const uptime = Math.max(0, (now - startedAt) / 1_000);
  return [
    '# HELP casa_clara_web_up Whether this web process is serving requests.',
    '# TYPE casa_clara_web_up gauge',
    'casa_clara_web_up 1',
    '# HELP casa_clara_web_uptime_seconds Process uptime in seconds.',
    '# TYPE casa_clara_web_uptime_seconds gauge',
    `casa_clara_web_uptime_seconds ${uptime.toFixed(3)}`,
    '# HELP casa_clara_web_memory_bytes Process memory without request or user labels.',
    '# TYPE casa_clara_web_memory_bytes gauge',
    `casa_clara_web_memory_bytes{kind="rss"} ${memory.rss}`,
    `casa_clara_web_memory_bytes{kind="heap_used"} ${memory.heapUsed}`,
    ''
  ].join('\n');
}
