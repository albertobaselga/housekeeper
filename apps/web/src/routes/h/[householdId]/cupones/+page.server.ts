import { loadCoupons } from '$lib/server/coupons.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getCouponsFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends, setHeaders }) => {
  // Patrón wiki (latencia): usar, anular, descartar, recuperar y guardar
  // re-ejecutan SOLO este load con `invalidate('cc:coupons')` tras el acuse.
  //
  // El filtro (`?ver=`), la búsqueda y la hoja de detalle (`?cupon=`) viven en
  // el cliente: este load no lee la URL a propósito, para que cambiar de
  // filtro o abrir un cupón no vuelva a pedir la cartera entera.
  depends('cc:coupons');

  // La cartera no se guarda en el dispositivo. El service worker guarda cada
  // navegación con éxito que no diga `no-store` (`storable()`) y la sirve sin
  // red: este HTML lleva TODOS los códigos y las notas, y se enseñaría sin
  // red (D-offline: «solo con red») y a quien use después un móvil compartido,
  // también tras cerrar la sesión (D-audiencia). Es la misma razón por la que
  // la foto va con `no-store`: el código vale dinero. Va antes de leer nada,
  // para que valga también para el 503 y para la demostración.
  setHeaders({ 'cache-control': 'private, no-store' });

  const coupons = locals.user ? await loadCoupons({ id: locals.user.id }, params.householdId) : null;
  if (coupons) return { coupons, live: true };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ coupons: getCouponsFixture(), live: false }));
};
