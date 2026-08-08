#!/usr/bin/env node
/**
 * Copia de seguridad COMPLETA y a demanda: base de datos + adjuntos, en un
 * solo comando.
 *
 *     pnpm backup:full
 *
 * El propietario no quiere copias automáticas: quiere poder pedir una cuando
 * le apetezca y saber que está entera. Por eso este script no programa nada,
 * no borra nada y no depende de que el proveedor tenga copias activadas.
 *
 * Qué hace, en orden:
 *   1. `pg_dump --format=custom --compress=zstd:9` de la base, y lo VERIFICA
 *      con `pg_restore --list` antes de dar el fichero por bueno (mismo
 *      contrato que infra/backup/db-backup.sh).
 *   2. Descarga todos los objetos del bucket privado con el SDK de S3, que es
 *      el mismo que usa la app: sirve igual para MinIO autogestionado que para
 *      el endpoint S3 de Supabase Storage.
 *   3. Escribe SHA256SUMS de todo y un manifest.json con qué se copió, de
 *      dónde y cuándo.
 *   4. Comprueba que el recuento de objetos descargados coincide con el
 *      listado. Una copia a medias falla en voz alta; nunca se anuncia como
 *      correcta.
 *
 * Variables (ver .env.example):
 *   BACKUP_DATABASE_URL   conexión DIRECTA (5432) con rol propietario. Por el
 *                         pooler en modo transacción `pg_dump` no funciona.
 *   S3_ENDPOINT, S3_REGION, S3_PRIVATE_BUCKET,
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 *   BACKUP_DIR            destino (por omisión ./artifacts/backups)
 *   PG_DUMP / PG_RESTORE  rutas de los binarios si no están en el PATH
 *
 * Restaurar es el camino inverso y está en docs/runbooks/backup-restore.md.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

function required(key) {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Falta la variable ${key}`);
    process.exit(78); // EX_CONFIG
  }
  return value;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'], ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} salió con código ${code}`))
    );
  });
}

async function sha256(path) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function listFiles(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(root, path)));
    else found.push(path);
  }
  return found.sort();
}

/**
 * Clave → ruta local, con la comprobación que impide que un `../` en el nombre
 * de un objeto escriba fuera del directorio de la copia.
 */
export function safeTarget(baseDirectory, key) {
  const target = resolve(baseDirectory, key);
  if (target !== baseDirectory && !target.startsWith(baseDirectory + sep)) {
    throw new Error(`Clave de objeto fuera del destino: ${key}`);
  }
  return target;
}

async function dumpDatabase(databaseUrl, target) {
  const partial = `${target}.partial`;
  await run(process.env.PG_DUMP?.trim() || 'pg_dump', [
    '--format=custom',
    '--compress=zstd:9',
    '--no-owner',
    '--no-acl',
    `--file=${partial}`,
    databaseUrl
  ]);
  // Verificación ANTES de publicar: un dump que no se puede listar no es copia.
  await run(process.env.PG_RESTORE?.trim() || 'pg_restore', ['--list', partial]);
  await rename(partial, target);
  return (await stat(target)).size;
}

export async function downloadBucket(client, bucket, directory) {
  let continuationToken;
  let listed = 0;
  let downloaded = 0;
  let bytes = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken })
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key || object.Key.endsWith('/')) continue;
      listed += 1;
      const target = safeTarget(directory, object.Key);
      await mkdir(dirname(target), { recursive: true });
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      if (!result.Body) throw new Error(`El objeto ${object.Key} llegó sin contenido`);
      const body = Buffer.from(await result.Body.transformToByteArray());
      await writeFile(target, body);
      downloaded += 1;
      bytes += body.length;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  if (downloaded !== listed) {
    throw new Error(`El bucket listó ${listed} objetos y solo se descargaron ${downloaded}`);
  }
  return { objects: downloaded, bytes };
}

async function main() {
  const databaseUrl = required('BACKUP_DATABASE_URL');
  const bucket = required('S3_PRIVATE_BUCKET');
  const endpoint = required('S3_ENDPOINT');
  const region = process.env.S3_REGION?.trim() || 'eu-west-1';

  const timestamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const root = resolve(process.env.BACKUP_DIR?.trim() || 'artifacts/backups');
  const directory = join(root, timestamp);
  const partialDirectory = `${directory}.partial`;
  await rm(partialDirectory, { recursive: true, force: true });
  await mkdir(join(partialDirectory, 'objetos'), { recursive: true });

  console.log(`Copia de seguridad en ${directory}`);
  console.log('1/3 Base de datos…');
  const dumpBytes = await dumpDatabase(databaseUrl, join(partialDirectory, 'base.dump'));

  console.log('2/3 Adjuntos…');
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY')
    }
  });
  const objects = await downloadBucket(client, bucket, join(partialDirectory, 'objetos'));

  console.log('3/3 Huellas y manifiesto…');
  const files = await listFiles(partialDirectory);
  const lines = [];
  for (const file of files) {
    lines.push(`${await sha256(file)}  ${relative(partialDirectory, file)}`);
  }
  await writeFile(join(partialDirectory, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o600 });
  await writeFile(
    join(partialDirectory, 'manifest.json'),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        // La cadena de conexión NO se escribe: llevaría la contraseña.
        database: { dumpBytes, format: 'pg_dump custom, zstd:9', verifiedWith: 'pg_restore --list' },
        storage: { endpoint, region, bucket, ...objects },
        note: 'Copia manual y completa. Guárdala cifrada y FUERA del proveedor (ADR 0001).'
      },
      null,
      2
    )}\n`
  );

  // El directorio solo recibe su nombre definitivo cuando está entero: nadie
  // puede confundir una copia interrumpida con una copia buena.
  await rename(partialDirectory, directory);
  console.log(
    `Copia verificada: base ${(dumpBytes / 1024 / 1024).toFixed(1)} MiB, ` +
      `${objects.objects} adjunto(s) (${(objects.bytes / 1024 / 1024).toFixed(1)} MiB) → ${directory}`
  );
}

// Solo al invocarlo como comando: importarlo (pruebas) no debe copiar nada.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`La copia de seguridad ha fallado: ${error.message}`);
    process.exitCode = 1;
  });
}
