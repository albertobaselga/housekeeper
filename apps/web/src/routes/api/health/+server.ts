import { json } from '@sveltejs/kit';
import { readWebHealth } from '$lib/server/health.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
  json(readWebHealth(), {
    headers: {
      'cache-control': 'no-store'
    }
  });
