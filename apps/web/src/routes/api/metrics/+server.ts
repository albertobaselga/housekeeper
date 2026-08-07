import { renderWebMetrics } from '$lib/server/health.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
  new Response(renderWebMetrics(), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; version=0.0.4; charset=utf-8'
    }
  });
