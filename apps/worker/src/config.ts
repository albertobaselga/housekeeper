export interface WorkerConfig {
  databaseUrl: string;
  healthPort: number;
  maxJobAttempts: number;
  pollIntervalMs: number;
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Falta la variable ${key}`);
  return value;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} debe ser un entero positivo`);
  }
  return value;
}

export function loadWorkerConfig(env = process.env): WorkerConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    healthPort: positiveInteger(env, "WORKER_HEALTH_PORT", 3001),
    maxJobAttempts: positiveInteger(env, "WORKER_MAX_JOB_ATTEMPTS", 5),
    pollIntervalMs: positiveInteger(env, "WORKER_POLL_INTERVAL_MS", 1_000),
    storage: {
      endpoint: required(env, "S3_ENDPOINT"),
      region: env.S3_REGION?.trim() || "eu-west-1",
      bucket: required(env, "S3_PRIVATE_BUCKET"),
      accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    },
  };
}
