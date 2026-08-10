// Alta de las cuentas reales de un hogar: identidad en Better Auth (usuario +
// contraseña) y membresía de aplicación en el esquema `app`. Es el guion de
// producción, hermano de seed-demo-users.mjs pero SIN las rejas de entorno
// sintético: aquí sí se crean personas de verdad.
//
// Los datos NUNCA viven en el repositorio: se pasan en un JSON externo.
//
//   node scripts/seed-household-accounts.mjs --config /ruta/fuera/del/repo/hogar.json
//
// Opciones:
//   --config <ruta>      obligatorio. JSON con el hogar y las personas.
//   --reset-passwords    repone también la contraseña de las cuentas que ya
//                        existen (sin esta bandera nunca se toca una contraseña
//                        en marcha: volver a ejecutar el guion es inofensivo).
//   --dry-run            dice qué haría y no escribe nada.
//
// Entorno:
//   DATABASE_AUTH_URL    login de auth (search_path=auth)
//   BETTER_AUTH_SECRET
//   SEED_DATABASE_URL    propietario de las migraciones del esquema app
//   BETTER_AUTH_URL      opcional; solo afecta a las URL absolutas de Better Auth
//
// Formato del JSON (ejemplo en docs/despliegue/acceso-produccion.md):
//
//   {
//     "household": { "slug": "casa-roble", "displayName": "Casa Roble" },
//     "people": [
//       { "username": "alberto", "name": "Alberto", "email": "alberto@ejemplo.es", "role": "family_admin" },
//       { "username": "nuria",  "name": "Nuria",  "email": "nuria@casa.local", "role": "employee_live_in" }
//     ]
//   }
//
// Cada persona puede traer `password`; si no la trae, el guion genera una fuerte
// y la imprime UNA sola vez por salida estándar para que se reparta en persona.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';

// Node 24 ejecuta TypeScript borrando los tipos: el guion usa EXACTAMENTE la
// misma configuración de Better Auth que el servidor web, sin copiarla.
import {
  AUTH_ADMIN_ROLE,
  AUTH_MEMBER_ROLE,
  createAuthCore,
  MIN_PASSWORD_LENGTH,
  runAuthMigrations
} from '../src/lib/server/auth-core.ts';

/** Roles de app.household_role (packages/db/migrations/0001_identity_and_context.sql). */
const APP_ROLES = ['family_admin', 'family_member', 'employee_live_in', 'helper', 'viewer'];
/** Solo las administradoras de la familia pueden reponer contraseñas ajenas. */
const ADMIN_APP_ROLE = 'family_admin';
/** Alfabeto sin caracteres que se confunden al dictar (0/O, 1/l/I). */
const DICTABLE = 'abcdefghjkmnpqrstuvwxyz23456789';

function parseArgs(argv) {
  const args = { config: null, resetPasswords: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') args.config = argv[++i];
    else if (flag.startsWith('--config=')) args.config = flag.slice('--config='.length);
    else if (flag === '--reset-passwords') args.resetPasswords = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else throw new Error(`Opción desconocida: ${flag}`);
  }
  if (!args.config) throw new Error('Falta --config <ruta al JSON del hogar>');
  return args;
}

function requireEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable ${key}`);
  return value;
}

/** Contraseña fuerte y dictable: 4 grupos de 5, ~98 bits de entropía. */
function generatePassword() {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (byte) => DICTABLE[byte % DICTABLE.length]);
  return [0, 5, 10, 15].map((start) => chars.slice(start, start + 5).join('')).join('-');
}

/**
 * Rechaza contraseñas flojas cuando las trae el JSON. No hay excepción posible:
 * una contraseña floja aquí es la puerta de la casa abierta.
 */
function assertStrongPassword(password, username) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña de ${username} es demasiado corta (mínimo ${MIN_PASSWORD_LENGTH})`);
  }
  if (password.toLowerCase().includes(username.toLowerCase())) {
    throw new Error(`La contraseña de ${username} contiene su nombre de usuario`);
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (password.length < 16 && classes < 3) {
    throw new Error(
      `La contraseña de ${username} es débil: usa 16 caracteres o más, o mezcla al menos tres tipos (minúsculas, mayúsculas, cifras, signos)`
    );
  }
}

function normalizeConfig(raw) {
  const household = raw?.household;
  if (!household?.slug || !household?.displayName) {
    throw new Error('El JSON necesita household.slug y household.displayName');
  }
  if (!Array.isArray(raw.people) || raw.people.length === 0) {
    throw new Error('El JSON necesita una lista `people` con al menos una persona');
  }
  const usernames = new Set();
  const people = raw.people.map((person) => {
    const username = String(person?.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
      throw new Error(`Nombre de usuario inválido: ${JSON.stringify(person?.username)} (3-30 letras, cifras, «_» o «.»)`);
    }
    if (usernames.has(username)) throw new Error(`Nombre de usuario repetido: ${username}`);
    usernames.add(username);
    const name = String(person?.name ?? '').trim();
    if (!name) throw new Error(`Falta el nombre visible de ${username}`);
    const email = String(person?.email ?? '').trim().toLowerCase();
    // El CHECK de app.user_profiles.email exige forma de correo; no exige que
    // sea entregable (0006_reminders_and_autoconfirm.sql). Nunca se le escribe.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`Correo con forma inválida para ${username}: ${email || '(vacío)'}`);
    }
    const role = String(person?.role ?? '').trim();
    if (!APP_ROLES.includes(role)) {
      throw new Error(`Rol inválido para ${username}: ${role || '(vacío)'}. Válidos: ${APP_ROLES.join(', ')}`);
    }
    const password = person?.password == null ? null : String(person.password);
    if (password) assertStrongPassword(password, username);
    return { username, name, email, role, password };
  });
  if (!people.some((person) => person.role === ADMIN_APP_ROLE)) {
    throw new Error(`El hogar necesita al menos una persona con rol ${ADMIN_APP_ROLE}`);
  }
  if (people.filter((person) => person.role === ADMIN_APP_ROLE).length < 2) {
    console.warn(
      `AVISO: solo hay una persona con rol ${ADMIN_APP_ROLE}. Si pierde su contraseña no habrá quien se la reponga; ` +
        'ten siempre dos administradoras (docs/despliegue/acceso-produccion.md §4).'
    );
  }
  return {
    household: {
      id: household.id ?? null,
      slug: String(household.slug).trim(),
      displayName: String(household.displayName).trim()
    },
    people
  };
}

const args = parseArgs(process.argv.slice(2));
const config = normalizeConfig(JSON.parse(await readFile(resolve(args.config), 'utf8')));

if (args.dryRun) {
  console.log(`--dry-run: no se escribe nada. Hogar ${config.household.displayName} (${config.household.slug}).`);
  for (const person of config.people) {
    const origin = person.password ? 'contraseña del JSON' : 'contraseña generada';
    console.log(`  ${person.username.padEnd(14)} ${person.role.padEnd(18)} ${person.email}  · ${origin}`);
  }
  process.exit(0);
}

const { auth, pool: authPool } = createAuthCore({
  databaseUrl: requireEnv('DATABASE_AUTH_URL'),
  secret: requireEnv('BETTER_AUTH_SECRET'),
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'
});
const appPool = new pg.Pool({ connectionString: requireEnv('SEED_DATABASE_URL'), max: 2 });

/** Lo que hay que decirle en persona a cada quien, al final y de una sola vez. */
const secretsToHandOut = [];
const summary = [];

try {
  await runAuthMigrations(auth);
  const context = await auth.$context;

  for (const person of config.people) {
    // El rol de Better Auth NO es la autorización de la app (eso es la
    // membresía bajo RLS): habilita el plugin admin para reponer contraseñas.
    const authRole = person.role === ADMIN_APP_ROLE ? AUTH_ADMIN_ROLE : AUTH_MEMBER_ROLE;
    const existing = await context.internalAdapter.findUserByEmail(person.email);
    let userId;
    let created = false;
    let passwordSet = false;

    if (existing?.user) {
      userId = existing.user.id;
      // El nombre de usuario solo viaja en el `update` cuando cambia de verdad:
      // el plugin `username` valida unicidad en cada actualización y sin sesión
      // no sabe que la fila que encuentra es la de esta misma persona.
      const renames =
        existing.user.username === person.username
          ? {}
          : { username: person.username, displayUsername: person.username };
      await context.internalAdapter.updateUser(userId, {
        name: person.name,
        role: authRole,
        ...renames
      });
      if (args.resetPasswords || person.password) {
        const password = person.password ?? generatePassword();
        const hash = await context.password.hash(password);
        const accounts = await context.internalAdapter.findAccounts(userId);
        if (accounts.some((account) => account.providerId === 'credential')) {
          await context.internalAdapter.updatePassword(userId, hash);
        } else {
          await context.internalAdapter.createAccount({
            userId,
            providerId: 'credential',
            accountId: userId,
            password: hash
          });
        }
        // Reponer una contraseña deja fuera las sesiones que hubiera abiertas.
        await context.internalAdapter.deleteUserSessions(userId);
        if (!person.password) secretsToHandOut.push({ username: person.username, password });
        passwordSet = true;
      }
    } else {
      const password = person.password ?? generatePassword();
      // `createUser` + `createAccount` en lugar de `signUpEmail`: el alta por
      // HTTP está cerrada a propósito (disableSignUp) en TODOS los entornos, y
      // este guion no la reabre ni por un instante.
      const user = await context.internalAdapter.createUser({
        name: person.name,
        email: person.email,
        emailVerified: true,
        username: person.username,
        displayUsername: person.username,
        role: authRole
      });
      userId = user.id;
      await context.internalAdapter.createAccount({
        userId,
        providerId: 'credential',
        accountId: userId,
        password: await context.password.hash(password)
      });
      created = true;
      passwordSet = true;
      if (!person.password) secretsToHandOut.push({ username: person.username, password });
    }

    summary.push({ ...person, userId, created, passwordSet });
  }

  const client = await appPool.connect();
  let householdId = config.household.id;
  try {
    await client.query('begin');
    // El propietario de las migraciones puede saltar FORCE RLS explícitamente.
    await client.query('set local row_security = off');
    const existingHousehold = await client.query('select id from app.households where slug = $1', [
      config.household.slug
    ]);
    householdId = existingHousehold.rows[0]?.id ?? householdId ?? randomUUID();
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, $2, $3)
       on conflict (slug) do update set display_name = excluded.display_name`,
      [householdId, config.household.slug, config.household.displayName]
    );
    for (const person of summary) {
      await client.query(
        `insert into app.user_profiles (user_id, display_name, email)
         values ($1, $2, $3)
         on conflict (user_id) do update
           set display_name = excluded.display_name, email = excluded.email`,
        [person.userId, person.name, person.email]
      );
      await client.query(
        `insert into app.household_memberships (household_id, user_id, role)
         values ($1, $2, $3)
         on conflict (household_id, user_id)
         do update set role = excluded.role, revoked_at = null, expires_at = null`,
        [householdId, person.userId, person.role]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  console.log(`Hogar ${config.household.displayName} (${config.household.slug}) → ${householdId}`);
  for (const person of summary) {
    const state = person.created ? 'creada  ' : person.passwordSet ? 'repuesta' : 'existente';
    console.log(`  ${state}  ${person.username.padEnd(14)} ${person.role.padEnd(18)} ${person.email}`);
  }
  if (secretsToHandOut.length > 0) {
    console.log('\nContraseñas generadas. Se muestran UNA sola vez: apúntalas ahora y');
    console.log('entrégalas en persona. Cada quien debe cambiarla desde «Tu contraseña» al entrar.\n');
    for (const secret of secretsToHandOut) {
      console.log(`  ${secret.username.padEnd(14)} ${secret.password}`);
    }
    console.log('');
  }
  console.log('Alta aplicada de forma idempotente.');
} finally {
  await authPool.end();
  await appPool.end();
}
