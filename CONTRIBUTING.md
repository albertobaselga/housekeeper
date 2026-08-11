# Cómo trabajar en Casa Clara

Repositorio privado, un mantenedor y agentes trabajando en paralelo. Estas son
las reglas mínimas que evitan pisarse.

## Antes de escribir código

1. `corepack enable && pnpm install --frozen-lockfile`. Node 24.18.0 y pnpm
   10.17.1: no uses otras versiones, están fijadas en `engines`, `.nvmrc` y la
   acción de setup del CI.
2. Rama propia `codex/<tema>` o `feat/<tema>`. Nunca commits directos a `main`.
3. Si vas a tocar base de datos, lee primero
   [docs/architecture/delivery-quality-contract.md](docs/architecture/delivery-quality-contract.md).

## Reglas que no se negocian

- **Sólo datos sintéticos.** Nombres, correos (`*.demo`), teléfonos en rangos no
  asignables (`+34 600 000 xxx`, `+34 910 000 xxx`) y ninguna dirección real. Se
  aplica también a capturas de pantalla y a los ficheros de ejemplo.
- **Nunca un secreto en el árbol.** Los `.env*` están ignorados salvo los
  `.example`, y `security.yml` pasa gitleaks sobre el **historial completo** en
  cada PR. Un secreto commiteado hay que rotarlo, no sólo borrarlo: ver
  [docs/runbooks/security-incident.md](docs/runbooks/security-incident.md).
- **Las migraciones son append-only.** Se añade `00NN_*.sql`; no se reescribe ni
  se reordena ninguna existente. `pnpm db:migrate` registra el SHA-256 de cada
  una y un cambio retroactivo rompe cualquier base ya migrada.
- **Ninguna batería sin job.** Si añades un fichero de spec, tiene que existir un
  job en `.github/workflows/ci.yml` que lo ejecute. El gate `suite-coverage`
  falla si no. **No se relaja el gate**: se le da al fichero el job o el entorno
  que necesita. Ese gate existe porque durante meses 18 de 27 specs de Playwright
  no las corría nadie.
- **Fallar cerrado.** Si falta una dependencia (base de datos, almacén de
  documentos, SMTP), la respuesta correcta es un error visible, no una
  degradación silenciosa que parezca éxito. Cuando se decide **prescindir** de
  una pieza —el antivirus de los adjuntos, por ejemplo— no basta con que deje de
  ser obligatoria: hay que dejar escrito el riesgo asumido y cómo se revierte
  (`docs/security/adjuntos-sin-antivirus.md` es el modelo).

## Ejecutar las suites en local

La tabla completa de comando → job está en el [README](README.md#cómo-se-ejecutan-las-suites).
Lo que hay que recordar:

```bash
export TEST_DATABASE_URL="postgresql://usuario@127.0.0.1:5432/casaclara_dev"
export E2E_DATABASE_URL="postgresql://usuario@127.0.0.1:5432/casaclara_e2e"
```

**En secuencia, nunca en paralelo.** Las suites de integración recrean el
esquema y crean bases y roles de **nombre fijo** (`casaclara_access_it`,
`it_casa_clara_app_login`, `e2e_casa_clara_web`…). Dos a la vez sobre el mismo
clúster se destruyen mutuamente y los fallos que produce eso son difíciles de
leer. Si necesitas paralelismo, usa clústeres distintos —que es exactamente lo
que hace el CI, un contenedor de PostgreSQL por job.

Si compartes clúster con otra persona o con otro worktree, prefija tus bases
(`casaclara_<algo>_*`) y no toques las ajenas.

## Commits y pull requests

- Mensajes en español, formato `tipo(ámbito): qué cambia`, imperativo y
  concreto. El cuerpo explica **por qué**, no repite el diff.
- Un PR, un tema. La plantilla de PR pide cómo lo has comprobado: rellénala con
  lo que has ejecutado tú, no con «pasa el CI».
- El check que hay que exigir en la protección de rama es **`deployable`**:
  agrupa los nueve jobs de calidad y falla si alguno no acabó en verde.

## Dónde vive cada cosa

Mapa del monorepo en el [README](README.md#mapa-del-monorepo). Fronteras que
conviene respetar:

- `packages/contracts` es el contrato público entre web, worker y dominio: un
  cambio ahí afecta a todos, versiónalo y avísalo.
- `packages/domain` es puro: sin `pg`, sin `fetch`, sin reloj. Si necesitas la
  hora, se pasa como argumento.
- El aislamiento por hogar vive en SQL (`packages/db/migrations`), no en la
  aplicación. La capa de servidor fija el contexto con `set_config(..., true)`
  dentro de la transacción; no añadas caminos que lo esquiven.
