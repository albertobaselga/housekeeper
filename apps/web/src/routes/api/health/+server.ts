import { json } from '@sveltejs/kit';
import { readWebHealth } from '$lib/server/health.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) =>
  json(readWebHealth(Date.now(), locals.syntheticOnly), {
    headers: {
      'cache-control': 'no-store'
    }
  });
