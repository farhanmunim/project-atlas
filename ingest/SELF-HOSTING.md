# Self-hosted warehouse — setup runbook

How the Atlas warehouse (the `/api/v1/history/*` backend + everything the `ingest/`
pipeline writes) runs on our own VPS via Coolify. This replaced Supabase cloud on
2026-07-03 after the free tier's 500MB cap put the project in read-only mode.
Follow this to rebuild the stack from scratch; every step was validated live.

## Architecture

```
Cloudflare Pages Function (/api/v1/history/*)          ingest pipeline (writes)
        │  WAREHOUSE_URL + WAREHOUSE_ANON_KEY                  │  WAREHOUSE_URL + WAREHOUSE_SERVICE_KEY
        ▼                                                      ▼
   https://atlas-db.farhan.app/rest/v1/*   ← Coolify proxy, strips /rest/v1 →   PostgREST :3000
                                                                                    │ authenticator
                                                                                    ▼
                                                                               Postgres 18
```

Three Coolify resources (project **London Buses (Atlas) DB → production**):

| Resource | What | Image / source |
|---|---|---|
| `atlas-db` | Postgres 18 | `postgres:18-alpine`, **not** publicly exposed, no port mapping |
| `atlas-postgrest` | HTTP API over the DB | `postgrest/postgrest:latest`, domain `https://atlas-db.farhan.app/rest/v1`, **Ports Exposes 3000**, **Strip Prefixes ON** |
| `atlas-ingest` | pipeline worker (idles, cron-exec'd) | GitHub App source → this repo, Build Pack **Dockerfile**, Base Directory `/ingest` |

## 1 — Postgres (`atlas-db`)

Plain Postgres. After first boot, bootstrap the four PostgREST roles (the migrations'
`TO anon` policies assume them but don't create them). In the resource Terminal:

```sql
CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '<generate + save>';
CREATE ROLE anon NOLOGIN;
GRANT anon TO authenticator;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT service_role TO authenticator;
CREATE ROLE authenticated NOLOGIN;
GRANT authenticated TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
```

Then load the schema (all migrations, one shot — the container has wget + psql):

```sh
cd /tmp && wget -O bundle.sql https://atlas.farhan.app/ingest/db/migrations-bundle.sql \
  && psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f bundle.sql
```

Adding a migration later: create `db/migrations/00NN_*.sql`, regenerate the bundle
(see its header), apply the single file the same wget+psql way, then
`NOTIFY pgrst, 'reload schema';` (PostgREST caches the schema — new tables 404 as
"not in schema cache" until reloaded; it listens on the `pgrst` channel).

## 2 — PostgREST (`atlas-postgrest`)

Docker-image resource, `postgrest/postgrest:latest`. Environment:

| Key | Value |
|---|---|
| `PGRST_DB_URI` | `postgres://authenticator:<password>@<atlas-db internal hostname>:5432/postgres` |
| `PGRST_DB_SCHEMA` | `public` |
| `PGRST_DB_ANON_ROLE` | `anon` |
| `PGRST_JWT_SECRET` | the JWT-signing secret (server-side only) |
| `PGRST_DB_MAX_ROWS` | `1000` |
| `PGRST_SERVER_PORT` | `3000` |

- Domain: `https://atlas-db.farhan.app/rest/v1` with **Strip Prefixes ON** — our code
  calls `<WAREHOUSE_URL>/rest/v1/<table>`, PostgREST serves tables at its root, the
  path-prefix domain + strip bridges the two. Root paths (no `/rest/v1`) 503 — correct.
- Healthy logs: `Successfully connected to PostgreSQL…`, `Schema cache loaded N Relations`.

## 3 — Keys (JWTs)

Supabase-style "anon key" / "service key" are just HS256 JWTs signed with
`PGRST_JWT_SECRET`, payload `{"role":"anon"|"service_role"}` (+ iss/iat/exp). Mint with
any JWT lib; set exp far out. They map to env vars:

| Var | Role | Used by |
|---|---|---|
| `WAREHOUSE_ANON_KEY` | `anon` (RLS-read) | Cloudflare Pages Function (+ local `.env`) |
| `WAREHOUSE_SERVICE_KEY` | `service_role` (BYPASSRLS) | ingest pipeline only — never the browser |

`WAREHOUSE_URL` = `https://atlas-db.farhan.app` (origin only; the code appends `/rest/v1`).
Set URL + anon key in Cloudflare Pages → Environment variables (encrypted) → redeploy.

## 4 — Ingest worker (`atlas-ingest`)

GitHub-App-sourced app, Build Pack **Dockerfile**, Base Directory `/ingest` (builds
`ingest/Dockerfile`: node:22-alpine, `npm ci --include=dev` — the runtime deps live in
devDependencies — then idles on `sleep infinity` for the tasks to exec into).

- Env: `BUS_API_KEY` (TfL), `DVLA_API_KEY`, `WAREHOUSE_URL`, `WAREHOUSE_SERVICE_KEY`.
- **Auto Deploy OFF** (Advanced) — a git push must not rebuild the container mid-run
  (rebuilds wipe generated data + kill running jobs). Redeploy manually.
- **Persistent Storage**: volume mounted at `/app/data` so warm caches (DVLA ~9k regs,
  tenders, MPS, geocode) survive redeploys.
- **Scheduled Tasks** (replaces the retired GitHub Actions; all UTC):

| Name | Command | Cron |
|---|---|---|
| weekly-refresh | `npm run refresh` | `23 9 * * 1` |
| daily-fleet-sample | `npm run sample-vehicles` | `37 8 * * *` |
| headway-sampler | `npm run sample-headways` | `*/30 6-22 * * *` |
| reliability-build | `npm run build-reliability` | `37 0 * * *` |

No heartbeat task — that existed only for Supabase free-tier auto-pause.

## Verify

```sh
curl https://atlas-db.farhan.app/rest/v1/keep_alive          # [] → PostgREST + routing OK
curl "https://atlas.farhan.app/api/v1/history/reliability-daily?limit=3"   # 200 → Cloudflare wired
```

Row counts per table (anon sees RLS-filtered; `vehicles` needs the service key by design):

```sh
curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Prefer: count=exact" -H "Range: 0-0" -i \
  "https://atlas-db.farhan.app/rest/v1/<table>?select=*" | grep -i content-range
```

## Gotchas learned the hard way

- **429s from TfL**: throttle windows last up to a minute; fetchers must back off
  properly (see the 429 handling in fetch-route-destinations/stops). Never run two
  refreshes concurrently.
- **Schema cache**: after any DDL, `NOTIFY pgrst, 'reload schema';` or new tables
  "don't exist" to PostgREST.
- **anon count = 0 ≠ empty**: `vehicles` (and anything without an anon policy) reads
  as 0 rows through the anon key — check with the service key before assuming data loss.
- **The static store is separate**: `data/*.json` + `refresh-data.yml` (GitHub) →
  Cloudflare is untouched by all of this; the site renders from it regardless of
  warehouse health.
