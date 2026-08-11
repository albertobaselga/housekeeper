// ───────────────────────────────────────────────────────────────────────────
// Cuentas de verdad (usuario + contraseña) para las capturas del manual.
//
// El manual tiene que enseñar la aplicación tal y como se usa en una casa: se
// entra escribiendo un nombre de usuario y una contraseña, y hay una pantalla
// para cambiarla. El selector de cuentas sintéticas no sirve para eso —con él
// la aplicación dice «esta instalación no usa contraseñas»—, así que para las
// capturas se monta identidad de verdad (Better Auth) sobre la MISMA base
// sintética de las fixtures.
//
// Y no crea gente nueva: engancha las cuentas de Better Auth a las membresías
// que ya trae la fixture, que son las que llevan colgado el contrato, las
// vacaciones, la lectura de la Guía y todo lo demás. Sin eso, quien entrara con
// contraseña vería un hogar vacío.
//
// Uso:
//   DATABASE_AUTH_URL=postgresql://casa_clara_auth_login:…@…/… \
//   SEED_DATABASE_URL=postgresql://casa_admin@…/…              \
//   BETTER_AUTH_SECRET=…                                       \
//   node apps/web/scripts/manual-shots-accounts.mjs
//
// Escribe por salida estándar un JSON con usuario y contraseña de cada persona,
// para que el guion de capturas pueda entrar. TODO es inventado.
// ───────────────────────────────────────────────────────────────────────────

import pg from 'pg';

import { AUTH_ADMIN_ROLE, AUTH_MEMBER_ROLE, createAuthCore, runAuthMigrations } from '../src/lib/server/auth-core.ts';

/** La contraseña es la misma para todas: es una maqueta, no una casa. */
const PASSWORD = 'manual-de-la-casa-2026';

const PEOPLE = [
  { fixture: 'fixture:roble:admin', username: 'alberto', name: 'Alberto', email: 'alberto@casaroble.invalid', admin: true },
  { fixture: 'fixture:roble:family', username: 'marta', name: 'Marta', email: 'marta@casaroble.invalid', admin: false },
  { fixture: 'fixture:roble:employee', username: 'ana', name: 'Ana', email: 'ana@casaroble.invalid', admin: false },
  { fixture: 'fixture:roble:helper', username: 'lucia', name: 'Lucía', email: 'lucia@casaroble.invalid', admin: false },
  { fixture: 'fixture:roble:viewer', username: 'diego', name: 'Diego', email: 'diego@casaroble.invalid', admin: false },
  { fixture: 'fixture:roble:employee2', username: 'nuria', name: 'Nuria', email: 'nuria@casaroble.invalid', admin: false },
  { fixture: 'fixture:roble:antigua', username: 'rosa', name: 'Rosa', email: 'rosa@casaroble.invalid', admin: false }
];

function requireEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable ${key}`);
  return value;
}

const { auth, pool: authPool } = createAuthCore({
  databaseUrl: requireEnv('DATABASE_AUTH_URL'),
  secret: requireEnv('BETTER_AUTH_SECRET'),
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:4363'
});
const appPool = new pg.Pool({ connectionString: requireEnv('SEED_DATABASE_URL'), max: 2 });

try {
  await runAuthMigrations(auth);
  const context = await auth.$context;

  const created = [];
  for (const person of PEOPLE) {
    const existing = await context.internalAdapter.findUserByEmail(person.email);
    let userId = existing?.user?.id ?? null;
    if (!userId) {
      const user = await context.internalAdapter.createUser({
        name: person.name,
        email: person.email,
        emailVerified: true,
        username: person.username,
        displayUsername: person.username,
        role: person.admin ? AUTH_ADMIN_ROLE : AUTH_MEMBER_ROLE
      });
      userId = user.id;
      await context.internalAdapter.createAccount({
        userId,
        providerId: 'credential',
        accountId: userId,
        password: await context.password.hash(PASSWORD)
      });
    }
    created.push({ ...person, userId });
  }

  // Reenganche: el perfil y la membresía de la fixture pasan a ser los de la
  // cuenta real. Es una sustitución de identificador, no un alta: todo lo que
  // cuelga de `membership_id` (contrato, vacaciones, lectura) sigue en su sitio.
  const client = await appPool.connect();
  try {
    await client.query('begin');
    await client.query('set local row_security = off');
    for (const person of created) {
      const previous = await client.query('select 1 from app.user_profiles where user_id = $1', [person.fixture]);
      if (previous.rowCount === 0) continue;
      await client.query(
        `insert into app.user_profiles (user_id, display_name, email, must_change_password)
         select $2, display_name, $3, must_change_password from app.user_profiles where user_id = $1
         on conflict (user_id) do nothing`,
        [person.fixture, person.userId, person.email]
      );
      await client.query('update app.household_memberships set user_id = $2 where user_id = $1', [
        person.fixture,
        person.userId
      ]);
      await client.query('update app.push_subscriptions set user_id = $2 where user_id = $1', [
        person.fixture,
        person.userId
      ]);
      await client.query('delete from app.user_profiles where user_id = $1', [person.fixture]);
    }
    await client.query('commit');
  } catch (cause) {
    await client.query('rollback');
    throw cause;
  } finally {
    client.release();
  }

  console.log(
    JSON.stringify(
      { password: PASSWORD, people: created.map(({ username, name, userId }) => ({ username, name, userId })) },
      null,
      2
    )
  );
} finally {
  await authPool.end();
  await appPool.end();
}
