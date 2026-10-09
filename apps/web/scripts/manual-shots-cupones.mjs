// ───────────────────────────────────────────────────────────────────────────
// La cartera de cupones de las capturas del manual (Casa Roble).
//
// Cupones no se puede sembrar solo con SQL, como el resto de
// `manual-shots-seed.sql`: cada cupón lleva una FOTO, y la foto son bytes en el
// almacén de adjuntos, no una fila. Sin bytes detrás, la ficha dice «La foto no
// se puede cargar ahora», que es justo lo que el manual no quiere retratar. Así
// que este guion hace las tres cosas a la vez, y con los mismos datos:
//
//   1. Pinta la foto de cada vale con el navegador de Playwright (una tarjeta
//      HTML con comercio, oferta y código, retratada en JPEG). Son vales
//      INVENTADOS: ni una foto real, ni un comercio real.
//   2. Sube cada foto al almacén S3 que leerá el servidor de las capturas
//      (MinIO en local), con la misma clave que apunta su fila.
//   3. Escribe las filas: `storage_objects` (con el sha256 de verdad de cada
//      foto), `coupons` y `coupon_uses`, con el rol propietario y sin RLS.
//
// Retira además la cartera de pruebas que deja la siembra de los e2e
// (`db-global-setup.ts`, prefijo cf…): «Comercio E2E 3» con una foto sin bytes
// no es lo que tiene que enseñar el manual.
//
// Es idempotente: las filas van con ON CONFLICT DO NOTHING y la subida
// sobrescribe la misma clave.
//
// Uso (después de manual-shots-seed.sql y manual-shots-accounts.mjs):
//   SEED_DATABASE_URL=postgresql://casa_admin@…/…                       \
//   S3_ENDPOINT=http://127.0.0.1:9000 S3_PRIVATE_BUCKET=manual-capturas \
//   S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…                           \
//   node apps/web/scripts/manual-shots-cupones.mjs
//
// El servidor de las capturas tiene que arrancar con las MISMAS S3_*: la ruta
// de la foto se niega a servir un objeto de otro bucket.
// ───────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { chromium } from '@playwright/test';
import pg from 'pg';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const ALBERTO = '11000000-0000-4000-8000-000000000001';
const MARTA = '11000000-0000-4000-8000-000000000002';

function requireEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable ${key}`);
  return value;
}

const bucket = requireEnv('S3_PRIVATE_BUCKET');
const s3 = new S3Client({
  endpoint: requireEnv('S3_ENDPOINT'),
  region: process.env.S3_REGION?.trim() || 'eu-west-1',
  forcePathStyle: true,
  credentials: { accessKeyId: requireEnv('S3_ACCESS_KEY_ID'), secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY') }
});

const id = (prefijo, n) => `${prefijo}-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Las fechas son relativas a hoy (en días), como en manual-shots-seed.sql: la
// captura se rehace cuando toque y ninguna caducidad se queda vieja.
//   · cuatro disponibles —uno «Caduca pronto», uno de varios usos ya empezado,
//     uno sin caducidad ni límite—, y uno de cada filtro restante.
const CUPONES = [
  {
    n: 1, comercio: 'Panadería La Espiga', oferta: 'Una barra gratis por cada cinco',
    codigo: 'ESPIGA-5', caduca: 20, usos: 5, notas: null, por: MARTA, alta: -12,
    tinta: '#7a4b1c', fondo: '#f6ead8', usados: [{ n: 1, hace: 9, por: MARTA }, { n: 2, hace: 3, por: ALBERTO }]
  },
  {
    n: 2, comercio: 'Frutería Huerta Clara', oferta: '2 × 1 en naranjas de zumo',
    codigo: 'HUERTA-2X1', caduca: 2, usos: 1, notas: 'Solo en el puesto del mercado, no en la tienda de la plaza.',
    por: ALBERTO, alta: -6, tinta: '#2f6b2a', fondo: '#e6f2dc', usados: []
  },
  {
    n: 3, comercio: 'Droguería Sol', oferta: '5 € de descuento a partir de 30 €',
    codigo: 'SOL5-OTONO', caduca: 45, usos: 1, notas: null, por: MARTA, alta: -4,
    tinta: '#8a5a00', fondo: '#fff3c9', usados: []
  },
  {
    n: 4, comercio: 'Librería Papel', oferta: '10 % en libros de lectura',
    codigo: null, caduca: null, usos: null, notas: 'Enseñar la foto en caja: no lleva código.', por: ALBERTO,
    alta: -30, tinta: '#24456b', fondo: '#e3ecf7', usados: [{ n: 3, hace: 14, por: ALBERTO }]
  },
  {
    n: 5, comercio: 'Zapatería Paso', oferta: '15 % en calzado infantil',
    codigo: 'PASO-15', caduca: 60, usos: 1, notas: null, por: ALBERTO, alta: -20,
    tinta: '#5b2e5e', fondo: '#f1e4f2', usados: [{ n: 4, hace: 5, por: MARTA }]
  },
  {
    n: 6, comercio: 'Pizzería Horno Viejo', oferta: 'Segunda pizza a mitad de precio',
    codigo: 'HORNO-50', caduca: -5, usos: 1, notas: null, por: MARTA, alta: -40,
    tinta: '#8c2f1c', fondo: '#f8e2dc', usados: []
  },
  {
    n: 7, comercio: 'Óptica Lumen', oferta: 'Revisión de la vista gratis',
    codigo: 'LUMEN-VISTA', caduca: 90, usos: 1, notas: null, por: ALBERTO, alta: -25, descartado: -2,
    tinta: '#1f5f5b', fondo: '#dff1ef', usados: []
  }
];

/** La foto del vale: una tarjeta de papel, con su recorte y su código. */
function tarjeta(c) {
  const escape = (texto) => texto.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  // Barras decorativas, no un código legible: el módulo no lee códigos y el
  // manual no necesita que nadie pueda escanear un vale inventado.
  const barras = Array.from({ length: 46 }, (_, i) => `<i style="width:${1 + ((i * 7 + c.n) % 4)}px"></i>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; background:#d9d4cb; font-family: Georgia, 'DejaVu Serif', serif; }
    .vale { margin:28px; padding:30px 34px; background:${c.fondo}; color:${c.tinta};
            border:3px dashed ${c.tinta}; border-radius:14px; transform: rotate(-1.2deg);
            box-shadow: 0 6px 18px rgba(0,0,0,.18); }
    .marca { font: 700 30px/1.1 'DejaVu Sans', sans-serif; letter-spacing:.02em; text-transform:uppercase; }
    .oferta { font-size:40px; line-height:1.15; margin:18px 0 22px; }
    .pie { display:flex; justify-content:space-between; align-items:flex-end; gap:20px;
           font: 400 17px/1.3 'DejaVu Sans', sans-serif; }
    .codigo { font: 700 24px/1 'DejaVu Sans Mono', monospace; letter-spacing:.08em; }
    .barras { display:flex; gap:2px; height:56px; margin-top:10px; }
    .barras i { background:${c.tinta}; display:block; }
  </style><div class="vale">
    <div class="marca">${escape(c.comercio)}</div>
    <div class="oferta">${escape(c.oferta)}</div>
    <div class="pie">
      <div>${c.codigo ? `<div class="codigo">${escape(c.codigo)}</div><div class="barras">${barras}</div>` : 'Presenta este vale en caja'}</div>
      <div>Vale de demostración<br>Datos inventados</div>
    </div>
  </div>`;
}

const pool = new pg.Pool({ connectionString: requireEnv('SEED_DATABASE_URL'), max: 2 });
const navegador = await chromium.launch();

try {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (cause) {
    if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(cause?.name)) throw cause;
  }

  const pagina = await navegador.newPage({ viewport: { width: 760, height: 420 }, deviceScaleFactor: 1.5 });
  const fotos = new Map();
  for (const c of CUPONES) {
    await pagina.setContent(tarjeta(c));
    const bytes = await pagina.screenshot({ type: 'jpeg', quality: 85 });
    const clave = `manual/cupones/vale-${c.n}.jpg`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: clave, Body: bytes, ContentType: 'image/jpeg' }));
    fotos.set(c.n, { clave, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local row_security = off');

    // Fuera la cartera de los e2e, en el orden que piden las claves ajenas.
    await client.query(`delete from app.coupon_uses where household_id = $1 and coupon_id::text like 'cf%'`, [HOUSEHOLD]);
    await client.query(`delete from app.coupons where household_id = $1 and id::text like 'cf%'`, [HOUSEHOLD]);
    await client.query(`delete from app.storage_objects where household_id = $1 and id::text like 'cf%'`, [HOUSEHOLD]);

    for (const c of CUPONES) {
      const foto = fotos.get(c.n);
      const alta = `now() + make_interval(days => ${c.alta})`;
      await client.query(
        `insert into app.storage_objects
           (id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id, created_at)
         values ($1, $2, $3, $4, 'image/jpeg', $5, $6, $7, ${alta})
         on conflict do nothing`,
        [id('c8100000', c.n), HOUSEHOLD, bucket, foto.clave, foto.bytes, foto.sha256, c.por]
      );
      await client.query(
        `insert into app.coupons
           (household_id, id, merchant, offer, code, expires_on, max_uses, notes,
            photo_storage_object_id, created_by_membership_id, created_at, updated_at,
            discarded_at, discarded_by_membership_id)
         values ($1, $2, $3, $4, $5, current_date + $6::int, $7, $8, $9, $10, ${alta}, ${alta},
                 case when $11::int is null then null else now() + make_interval(days => $11::int) end,
                 case when $11::int is null then null else $10::uuid end)
         on conflict do nothing`,
        [
          HOUSEHOLD, id('c8000000', c.n), c.comercio, c.oferta, c.codigo, c.caduca, c.usos, c.notas,
          id('c8100000', c.n), c.por, c.descartado ?? null
        ]
      );
      for (const uso of c.usados) {
        await client.query(
          `insert into app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id, recorded_at)
           values ($1, $2, $3, current_date - $4::int, $5, now() - make_interval(days => $4::int))
           on conflict do nothing`,
          [HOUSEHOLD, id('c8200000', uso.n), id('c8000000', c.n), uso.hace, uso.por]
        );
      }
    }
    await client.query('commit');
  } catch (cause) {
    await client.query('rollback');
    throw cause;
  } finally {
    client.release();
  }
  console.log(`${CUPONES.length} cupones con foto en «${bucket}»`);
} finally {
  await navegador.close();
  await pool.end();
}
