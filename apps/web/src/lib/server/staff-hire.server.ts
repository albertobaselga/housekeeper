import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import type { AgreementCreateInputV1 } from '@casa-clara/contracts';
import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import { explain, insertAgreementWithFirstVersion } from './agreement-terms.server';
import { AUTH_MEMBER_ROLE, MIN_PASSWORD_LENGTH, type AuthInstance } from './auth-core';
import { getAuth } from './auth.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:staff-hire');

/**
 * Alta de una persona del personal desde dentro de la aplicación: identidad,
 * membresía y —si se pactan aquí— contrato con su primera versión.
 *
 * Hasta ahora esto solo existía en `scripts/seed-household-accounts.mjs`: una
 * consola, tres variables de entorno y un JSON fuera del repositorio. Sirve
 * para montar una casa; no sirve para el día en que entra alguien nuevo.
 *
 * Lo delicado es que el alta toca DOS bases de datos que no comparten
 * transacción: la de identidad (Better Auth) y la de la aplicación. El orden
 * está elegido para que ningún fallo deje una puerta abierta:
 *
 *   1. Se comprueba bajo RLS que quien pide administra ESTE hogar. Si no, no se
 *      ha creado nada en ninguna parte.
 *   2. Se crea la identidad. Better Auth vuelve a exigir por su cuenta que
 *      quien llama sea administrador suyo.
 *   3. En UNA transacción de la aplicación: perfil, membresía y contrato.
 *   4. Si el paso 3 falla, se borra la identidad recién creada. Una cuenta sin
 *      membresía no entra a ningún sitio —la RLS la deja fuera y
 *      `resolveAppUser` devuelve null—, pero deja un nombre de usuario ocupado.
 *
 * El alta NUNCA crea una administradora: el papel de Better Auth es siempre el
 * de miembro y el papel de la casa es siempre de personal. Quien administra se
 * sigue dando de alta con el guion, deliberadamente.
 */

/** Papeles que esta pantalla puede dar. Administrar no está entre ellos. */
export const HIREABLE_ROLES = ['employee_live_in', 'helper'] as const;
export type HireableRole = (typeof HIREABLE_ROLES)[number];

/** Alfabeto sin caracteres que se confunden al dictar (0/O, 1/l/I). */
const DICTABLE = 'abcdefghjkmnpqrstuvwxyz23456789';

export interface HireInput {
  displayName: string;
  username: string;
  email: string;
  role: HireableRole;
  /** Condiciones pactadas en el mismo acto, o null para dar solo el acceso. */
  agreement: { startsOn: string; terms: AgreementCreateInputV1['terms'] } | null;
}

export type HireResult =
  | {
      ok: true;
      name: string;
      username: string;
      /** Se enseña UNA sola vez, para leerla en voz alta. No se guarda. */
      password: string;
      membershipId: string;
      agreementId: string | null;
    }
  | { ok: false; message: string };

/** Contraseña fuerte y dictable: 4 grupos de 5, ~98 bits de entropía. */
export function generateInitialPassword(): string {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (byte) => DICTABLE[byte % DICTABLE.length]);
  return [0, 5, 10, 15].map((start) => chars.slice(start, start + 5).join('')).join('-');
}

/**
 * Comprueba lo que la persona escribió antes de tocar nada. Las reglas son las
 * mismas que las del guion de alta, para que las dos puertas de la casa pidan
 * exactamente lo mismo.
 */
export function validateHireInput(input: HireInput): string | null {
  if (input.displayName.length < 2 || input.displayName.length > 120) {
    return 'El nombre visible tiene que tener entre 2 y 120 caracteres.';
  }
  if (!/^[a-z0-9_.]{3,30}$/.test(input.username)) {
    return 'El nombre de usuario son de 3 a 30 letras minúsculas, cifras, «_» o «.».';
  }
  // El correo es un identificador único, nunca un buzón: a nadie se le escribe.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    return 'El correo tiene que tener forma de correo. No se le escribe a nadie: solo identifica la cuenta.';
  }
  if (!(HIREABLE_ROLES as readonly string[]).includes(input.role)) {
    return 'Elige si entra como empleada interna o como apoyo del hogar.';
  }
  if (input.agreement) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.agreement.startsOn)) {
      return 'La fecha de inicio del contrato no es válida.';
    }
    if (input.agreement.terms.effectiveFrom < input.agreement.startsOn) {
      return 'La primera versión no puede entrar en vigor antes del inicio del contrato.';
    }
  }
  return null;
}

/** ¿Quien pide administra este hogar? Se pregunta antes de crear nada. */
async function isHouseholdAdmin(
  pool: Pool,
  userId: string,
  householdId: string
): Promise<boolean> {
  try {
    return await withAuthorizedTransaction(pool, { userId }, householdId, async (_client, membership) =>
      membership.role === 'family_admin'
    );
  } catch {
    return false;
  }
}

export async function hireHouseholdMember(
  user: { id: string },
  householdId: string,
  input: HireInput,
  headers: Headers,
  pool: Pool | null = getDatabasePool(),
  auth: AuthInstance | null = getAuth()
): Promise<HireResult> {
  if (!auth) return { ok: false, message: 'Este entorno no gestiona cuentas de acceso.' };
  if (!pool) return { ok: false, message: 'Este entorno no tiene base de datos.' };

  const invalid = validateHireInput(input);
  if (invalid) return { ok: false, message: invalid };

  if (!(await isHouseholdAdmin(pool, user.id, householdId))) {
    return { ok: false, message: 'Solo quien administra el hogar puede dar de alta a alguien.' };
  }

  const password = generateInitialPassword();
  let createdUserId: string | null = null;
  try {
    const created = await auth.api.createUser({
      body: {
        email: input.email,
        password,
        name: input.displayName,
        // Nunca `admin`: esta puerta no puede crear a quien administra.
        role: AUTH_MEMBER_ROLE,
        data: { username: input.username, displayUsername: input.username }
      },
      headers
    });
    createdUserId = created.user.id;
  } catch (cause) {
    const code = (cause as { body?: { code?: string } }).body?.code;
    if (code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
      return { ok: false, message: 'Ya hay una cuenta con ese correo.' };
    }
    if (code === 'USERNAME_IS_ALREADY_TAKEN') {
      return { ok: false, message: 'Ese nombre de usuario ya está cogido. Prueba con otro.' };
    }
    log.error('identity creation failed', { code: errorCode(cause) });
    return {
      ok: false,
      message:
        'No hemos podido crear la cuenta. Tu cuenta necesita ser administradora también en el sistema de acceso; revisa docs/despliegue/acceso-produccion.md.'
    };
  }

  try {
    const written = await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') {
        throw new AuthorizationError('Solo quien administra el hogar puede dar de alta a alguien');
      }
      // `must_change_password` desde el primer segundo: la contraseña la ha
      // tecleado otra persona y se va a decir en voz alta.
      await client.query(
        `insert into app.user_profiles (user_id, display_name, email, must_change_password)
         values ($1, $2, $3, true)`,
        [createdUserId, input.displayName, input.email]
      );
      const inserted = await client.query<{ id: string }>(
        `insert into app.household_memberships (household_id, user_id, role)
         values ($1, $2, $3::app.household_role)
         returning id`,
        [householdId, createdUserId, input.role]
      );
      const membershipId = inserted.rows[0]?.id;
      if (!membershipId) throw new Error('El alta de la membresía no devolvió identificador');

      let agreementId: string | null = null;
      if (input.agreement) {
        const result = await insertAgreementWithFirstVersion(client, householdId, membership.id, {
          employeeMembershipId: membershipId,
          startsOn: input.agreement.startsOn,
          terms: input.agreement.terms
        } as AgreementCreateInputV1);
        agreementId = result.agreementId;
      }
      return { membershipId, agreementId };
    });

    return {
      ok: true,
      name: input.displayName,
      username: input.username,
      password,
      membershipId: written.membershipId,
      agreementId: written.agreementId
    };
  } catch (cause) {
    // Compensación: la identidad existía y el hogar no llegó a conocerla.
    // Dejarla suelta no abre ninguna puerta (sin membresía, `resolveAppUser`
    // devuelve null), pero ocuparía el nombre de usuario para siempre.
    try {
      await auth.api.removeUser({ body: { userId: createdUserId }, headers });
    } catch (removal) {
      log.error('orphan identity left behind after a failed hire', {
        code: errorCode(removal),
        userId: createdUserId
      });
    }
    if (!(cause instanceof AuthorizationError)) {
      log.error('hire failed', { code: errorCode(cause) });
    }
    const code = (cause as { code?: string }).code;
    if (code === '23505') {
      return { ok: false, message: 'Esa persona ya está dada de alta en este hogar.' };
    }
    if (cause instanceof AuthorizationError) {
      return { ok: false, message: 'Solo quien administra el hogar puede dar de alta a alguien.' };
    }
    return { ok: false, message: explain(cause) };
  }
}

export { MIN_PASSWORD_LENGTH };
