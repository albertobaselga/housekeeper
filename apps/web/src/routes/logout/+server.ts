import { redirect, type RequestHandler } from '@sveltejs/kit';
import { destroyDemoSession } from '$lib/server/session.server';

export const POST: RequestHandler = ({ cookies, url }) => {
  destroyDemoSession(cookies, url.protocol === 'https:');
  redirect(303, '/login');
};
