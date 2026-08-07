// Semillas idempotentes de las cinco cuentas demo de Better Auth y sus
// membresías de aplicación. Solo tiene sentido con contraseña demo habilitada;
// las credenciales viven en el entorno (.env), nunca en el código.
//
// Requiere:
//   DATABASE_AUTH_URL     login de auth (search_path=auth)
//   BETTER_AUTH_SECRET
//   SEED_DATABASE_URL     propietario de las migraciones del esquema app
//   ENABLE_DEMO_PASSWORD_AUTH=true
//   DEMO_{ADMIN,MEMBER,EMPLOYEE,HELPER,VIEWER}_{NAME,EMAIL,PASSWORD}
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';

const SEED_HOUSEHOLD_ID = '30000000-0000-4000-8000-000000000001';
const SEED_HOUSEHOLD_SLUG = 'casa-clara';
const SEED_HOUSEHOLD_NAME = 'Casa Clara';

const SEED_ACCOUNTS = [
  { prefix: 'DEMO_ADMIN', role: 'family_admin' },
  { prefix: 'DEMO_MEMBER', role: 'family_member' },
  { prefix: 'DEMO_EMPLOYEE', role: 'employee_live_in' },
  { prefix: 'DEMO_HELPER', role: 'helper' },
  { prefix: 'DEMO_VIEWER', role: 'viewer' }
];

function requireEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable ${key}`);
  return value;
}

if (process.env.ENABLE_DEMO_PASSWORD_AUTH !== 'true') {
  throw new Error('Las semillas demo requieren ENABLE_DEMO_PASSWORD_AUTH=true');
}

const authPool = new pg.Pool({ connectionString: requireEnv('DATABASE_AUTH_URL'), max: 2 });
const appPool = new pg.Pool({ connectionString: requireEnv('SEED_DATABASE_URL'), max: 2 });

const auth = betterAuth({
  database: authPool,
  secret: requireEnv('BETTER_AUTH_SECRET'),
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  emailAndPassword: { enabled: true }
});

try {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  const context = await auth.$context;
  const seeded = [];
  for (const account of SEED_ACCOUNTS) {
    const name = requireEnv(`${account.prefix}_NAME`);
    const email = requireEnv(`${account.prefix}_EMAIL`).toLowerCase();
    const password = requireEnv(`${account.prefix}_PASSWORD`);
    let user = await context.internalAdapter.findUserByEmail(email);
    if (user?.user) {
      seeded.push({ id: user.user.id, name, email, role: account.role, created: false });
      continue;
    }
    const result = await auth.api.signUpEmail({ body: { name, email, password } });
    seeded.push({ id: result.user.id, name, email, role: account.role, created: true });
  }

  const client = await appPool.connect();
  try {
    await client.query('begin');
    // El propietario de las migraciones puede saltar FORCE RLS explícitamente.
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, $2, $3)
       on conflict (id) do nothing`,
      [SEED_HOUSEHOLD_ID, SEED_HOUSEHOLD_SLUG, SEED_HOUSEHOLD_NAME]
    );
    for (const account of seeded) {
      await client.query(
        `insert into app.user_profiles (user_id, display_name, email)
         values ($1, $2, $3)
         on conflict (user_id) do update
           set display_name = excluded.display_name, email = excluded.email`,
        [account.id, account.name, account.email]
      );
      await client.query(
        `insert into app.household_memberships (household_id, user_id, role)
         values ($1, $2, $3)
         on conflict (household_id, user_id)
         do update set role = excluded.role, revoked_at = null, expires_at = null`,
        [SEED_HOUSEHOLD_ID, account.id, account.role]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  for (const account of seeded) {
    console.log(`${account.created ? 'creada ' : 'existente'} ${account.role} (${account.name})`);
  }
  console.log('Semillas demo aplicadas de forma idempotente.');
} finally {
  await authPool.end();
  await appPool.end();
}
