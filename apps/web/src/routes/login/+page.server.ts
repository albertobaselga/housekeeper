import { dev } from '$app/environment';
import { error, fail, redirect } from '@sveltejs/kit';
import { ROLE_LABELS } from '$lib/auth/capabilities';
import { getDemoUser, listDemoUsers } from '$lib/server/fixtures.server';
import { createDemoSession } from '$lib/server/session.server';
import type { Actions, PageServerLoad } from './$types';

function isSafeNext(value: string | null): value is string {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//'));
}

function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

export const load: PageServerLoad = ({ locals, url }) => {
  if (locals.user) redirect(303, `/h/${encodeURIComponent(locals.user.householdIds[0])}/today`);
  return {
    next: isSafeNext(url.searchParams.get('next')) ? url.searchParams.get('next') : null,
    accounts: listDemoUsers().map(({ id, name, initials, email, role }) => ({
      id,
      name,
      initials,
      email,
      role,
      roleLabel: ROLE_LABELS[role]
    }))
  };
};

export const actions: Actions = {
  default: async ({ cookies, request, url }) => {
    if (!dev && !isLocalHostname(url.hostname)) error(403, 'El acceso demo solo está disponible en local');
    const formData = await request.formData();
    const accountId = String(formData.get('accountId') ?? '');
    const nextValue = String(formData.get('next') ?? '');
    const user = getDemoUser(accountId);
    if (!user) return fail(400, { message: 'Elige una cuenta demo válida.' });

    createDemoSession(cookies, user.id, url.protocol === 'https:');
    const destination = isSafeNext(nextValue)
      ? nextValue
      : `/h/${encodeURIComponent(user.householdIds[0])}/today`;
    redirect(303, destination);
  }
};
