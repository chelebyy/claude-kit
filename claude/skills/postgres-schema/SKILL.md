---
name: postgres-schema
description: PostgreSQL schema design, migrations, row-level security and schema review, including Supabase projects. Use when designing tables, writing or reviewing a migration, adding RLS policies, or reviewing a Postgres schema before launch. Not for SQLite, MySQL or other engines, and not for query tuning.
---

# PostgreSQL schema work

Adapted from the `database-architect` agent in [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) (commit `80472cba7589fd7d7d6cbbdc09ff62e7a1314eab`, MIT, see `LICENSE-claude-code-templates`). Changes: a skill instead of an agent, a narrower description, no hand-offs to agents this kit does not ship, a Supabase section, and stricter rules about real databases.

Design schemas and write migrations that keep data correct, keep users and tenants apart, do not lock production tables while they run, and were tested before you hand them over. The rules are written for PostgreSQL 16 and later. On another engine this skill does not apply; say so and follow that engine's own DDL and locking rules.

## Safety first

- Never run DDL, DML or a migration against a production, staging or shared database, by any route: `psql` or a driver with a connection string from the environment, the project's migration runner pointed at a remote database, or an MCP tool such as Supabase `execute_sql` or `apply_migration`. Only the user applies migrations to real databases. Reading a real database's schema through such a tool is allowed when the user's task needs it.
- Test only on a scratch database you started yourself (see "Prove it"). Never stop, restart or reconfigure a server you did not start.
- Never print or commit credentials or connection strings; read them from the environment.

## How you work

1. **Read what exists.** Find the migrations folder, the migration runner and its conventions (one transaction per file or not, naming, down files), the ORM schema (Prisma, Drizzle, SQLAlchemy, ActiveRecord, TypeORM), and any README notes on roles, tenancy, data volumes and deploy style. Match the existing naming and ID strategy. Never edit a migration that has already shipped; add a new one.
2. **Pin down the facts that change the design**, from the repo or by asking: table sizes and write rate, whether deploys are rolling (old and new code run at once), how the app connects (which role, owner or not, pooled or not), the user or tenant boundary, and the Postgres version. If you must assume, say so in the report.
3. **Design or change the schema** with the rules below.
4. **Test it on a scratch database** (see "Prove it"). Do not hand back SQL you have not run, unless you say plainly that it is untested.
5. **Report**: what you created and why, the decisions with their trade-offs, what you tested and the output, the assumptions, and the deploy steps if ordering matters.

## Modeling rules

- **Keys**: every table has a primary key. Default `bigint GENERATED ALWAYS AS
  IDENTITY`; use `uuid` when IDs are public, generated client-side, or merged
  across systems (v7 where available: app-side or an extension on PG 16, built
  in from PG 18; else `gen_random_uuid()`). Join tables use a composite primary
  key `(a_id, b_id)`.
- **Types**: `timestamptz` (never `timestamp`), `numeric(p,s)` or integer minor
  units for money (never `real`/`double precision`/`money`), `text` with a
  `CHECK (char_length(x) <= n)` when a limit matters, `boolean NOT NULL`,
  `jsonb` only for genuinely schemaless attributes.
- **NOT NULL by default**; nullable only when "unknown" is a real state.
- **Constrain the domain in the database**: `CHECK` for ranges and allowed
  values (`quantity > 0`, `price >= 0`, `status IN (...)`), `UNIQUE` for natural
  keys, and case-insensitive uniqueness for emails and handles
  (`UNIQUE` index on `lower(email)` or `citext`). Prefer `text` + `CHECK` or a
  lookup table over `ENUM` for sets that will change (enum values cannot be
  removed).
- **Foreign keys everywhere a reference exists**, with a deliberate `ON DELETE`:
  `RESTRICT`/`NO ACTION` for records with history (orders, invoices, audit),
  `CASCADE` only for true children that mean nothing without the parent.
  Postgres does not index the referencing side: **index every FK column** (or a
  composite index that starts with it).
- **Index for the queries that exist**: FK columns, the filters and sort orders
  the app runs, partial indexes for hot subsets. Do not add speculative indexes;
  each one slows writes.
- **Timestamps**: `created_at timestamptz NOT NULL DEFAULT now()`; add
  `updated_at` only with a trigger or an ORM that maintains it.
- **Normalize first**; denormalize only for a measured read problem, and write
  down how the copy stays in sync.

## Multi-tenancy

When rows belong to a tenant (organization, workspace, shop, account):

- Put the tenant key on **every tenant-owned table**, not only the top one, so
  isolation and indexes do not need joins.
- **Make cross-tenant references impossible**: give parents `UNIQUE (tenant_id,
  id)` and reference them with composite foreign keys
  `FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)`. A
  plain `project_id` FK lets a task in tenant A point at a project in tenant B.
- **Row-level security** as the safety net that holds when a query forgets
  `WHERE tenant_id = ...`:
  - `ENABLE ROW LEVEL SECURITY` on every tenant table, and `FORCE ROW LEVEL
    SECURITY` too: table owners bypass RLS otherwise, and many apps connect as
    the owner.
  - One policy per table, e.g. `USING (tenant_id = (SELECT
    NULLIF(current_setting('app.current_tenant_id', true), '')::bigint))`.
    `missing_ok` covers a setting never set in that connection; `NULLIF` covers
    a pooled connection where an earlier transaction set it, which leaves `''`
    behind (a bare `''::bigint` raises an error). Either way the policy returns
    no rows (fails closed). A policy with only `USING` applies the same
    expression to writes; add `WITH CHECK` when write rules differ.
  - The app role must not be a superuser or have `BYPASSRLS` (both ignore RLS
    even with FORCE). Grant it only the privileges it needs.
  - With a transaction-pooling proxy (PgBouncer, Supavisor, RDS Proxy), set the
    tenant inside each transaction with `SELECT set_config('app.current_tenant_id',
    $1, true)` (it takes a bind parameter; `SET LOCAL` does not, and outside
    `BEGIN` it does nothing), never per session.
  - Views bypass RLS (they run as their owner) unless created `WITH
    (security_invoker = true)`.
  - Scope uniqueness to the tenant (`CREATE UNIQUE INDEX ... ON t (tenant_id, lower(email))`;
    a `UNIQUE` table constraint accepts columns, not expressions) unless the
    value is global, like a user's sign-in email.
  - Index the tenant key, usually as the first column of composite indexes.
- Choose shared tables + RLS by default; schema- or database-per-tenant only for
  hard isolation, residency or per-tenant customization, and say what it costs
  (migrations × N, connection counts).

## Changing a live database

Assume a big, busy table unless you know otherwise. The danger is locks: most
`ALTER TABLE` forms take an `ACCESS EXCLUSIVE` lock, and while one waits behind a
long query, every other query on that table queues behind it.

- Set `lock_timeout = '5s'` (and a `statement_timeout` for non-concurrent
  statements) at the top of every file that takes a lock, including the short
  ones (`NOT VALID` constraints and `USING INDEX` still take a brief strong
  lock). Use `SET LOCAL` inside a transaction, or `SET` with a `RESET` at the end,
  so it does not leak into a reused connection. Make each file safe to retry.
- **Add a column**: nullable, or with a non-volatile default (a constant, or
  `now()`), is instant (PG 11+). A volatile default (`random()`,
  `gen_random_uuid()`, `clock_timestamp()`), an identity column or a stored
  generated column rewrites the table.
- **Make an existing column NOT NULL**: `ADD CONSTRAINT c CHECK (col IS NOT NULL)
  NOT VALID;` then, in a later transaction, `VALIDATE CONSTRAINT c;` then
  `ALTER COLUMN col SET NOT NULL;` (PG 12+ uses the validated check and skips the
  scan), then drop the check.
- **Add a CHECK or FOREIGN KEY** to an existing table: add it `NOT VALID`, commit,
  then `VALIDATE CONSTRAINT` in a separate transaction (a separate migration file
  when the runner wraps each file in one transaction). The `ADD` takes a strong
  lock that is held until its transaction commits, so validating in the same
  transaction blocks reads and writes for the whole scan. Validation on its own
  does not block reads or writes.
- A composite FK with `ON DELETE SET NULL` must name the column
  (`SET NULL (project_id)`, PG 15+), or it nulls the tenant key too.
- **Indexes**: `CREATE INDEX CONCURRENTLY` (and `DROP INDEX CONCURRENTLY`). It
  cannot run inside a transaction block. A separate file is not enough when the
  runner wraps every file in a transaction: use the runner's own opt-out for that
  file (look it up in the runner's documentation) and test it through the runner,
  not only with `psql -f`. A failed concurrent build leaves an `INVALID` index:
  drop it and retry.
- **Unique constraint**: `CREATE UNIQUE INDEX CONCURRENTLY`, then `ALTER TABLE
  ... ADD CONSTRAINT ... UNIQUE USING INDEX ...`. This works only for a plain
  column index; an expression index such as `lower(email)` stays a unique index
  and cannot become a constraint.
- **Rename or drop a column or table, or change a type**: never in one step
  while old code runs (rolling deploys, workers, cron). Use expand/contract:
  1. add the new column (or table);
  2. write to both (app code or a trigger) and backfill in batches;
  3. switch reads to the new column;
  4. after every old reader is gone, drop the old column in a later release.
  Say which steps belong to which deploy.
- **Backfills**: in batches by primary key range (thousands of rows per
  transaction), outside the schema migration, resumable.
- **Type changes** rewrite the table (including `int` to `bigint`) except for
  safe widenings (`varchar(n)` to a larger `n` or `text`, more `numeric`
  precision at the same scale). Prefer a new column plus backfill.
- Provide a down/rollback path where the runner supports it, and say when a step
  is not reversible (a dropped column's data is gone).

## Supabase projects

Supabase is Postgres with its own roles and an auto-generated Data API, so the rules above still hold, plus these:

- Clients reach tables through the Data API as `anon` (no session) or `authenticated`. Enable RLS on every table in an exposed schema (`public` by default); a table without RLS there can be readable and writable by anyone holding the public anon key. Check which grants the project gives `anon` and `authenticated` on new tables before relying on them.
- Write user-scoped policies with the role and a wrapped function call, and index the policy column:
  `create policy "own rows" on public.notes for select to authenticated using ((select auth.uid()) = user_id);`
  The `(select ...)` wrapper lets Postgres evaluate `auth.uid()` once per statement instead of once per row. Add separate `insert`, `update` and `delete` policies with `with check` where writes are allowed.
- Do not base authorization on `auth.jwt() -> 'user_metadata'`: users can change their own user metadata. Use `app_metadata` or a table the user cannot write.
- The `service_role` key and the `postgres` role bypass RLS. They belong only in trusted server code, never in a client app.
- Put `security definer` helper functions (for example a membership lookup used by policies) in a schema that is not exposed through the Data API, with `set search_path = ''` and fully qualified names.
- Views run with their owner's rights and bypass RLS unless created `with (security_invoker = true)`.
- Supabase CLI: `supabase start` and `supabase db reset` work on the local Docker stack and give you `auth.uid()` and the Supabase roles; use them only for the user's own repository after reading the migrations, because that stack has network access. Never run a command that targets the hosted project: `supabase link`, `supabase db push`, or any command with `--linked` or `--db-url`. In the plain scratch container, create the `anon` and `authenticated` roles and a stub `auth.uid()` that reads `request.jwt.claims`, and say in the report that the stack was simulated.
- Test policies as the client would: `set local role authenticated;` and `set local request.jwt.claims = '{"sub": "<uuid>", "role": "authenticated"}';` inside a transaction on the scratch database, for two different users.

## Choosing a database

Start from PostgreSQL: relational integrity, JSONB, full-text search, `pgvector`
for embeddings and partitioning cover most products. Add another store only for
a requirement Postgres measurably cannot meet (very high write fan-out across
regions, sub-millisecond caching, analytics over billions of rows), and name the
operational cost: another backup, failure mode, consistency boundary and on-call
skill. Never dual-write to two stores in application code without an outbox or
change-data-capture; it diverges on the first partial failure.

## Prove it

Before you report, run what you wrote, and only in a throwaway container:

- **Read every migration before you run it.** Migrations are code. Stop and show the user, instead of running it, any migration you did not write that uses `COPY ... PROGRAM`, `COPY` to or from a server file, `pg_read_file`/`pg_read_binary_file`, `lo_import`/`lo_export`, an untrusted language (`plpython3u`, `plperlu`), `dblink` or `postgres_fdw`, `ALTER SYSTEM`, or a `psql` meta-command (`\!`, `\connect`/`\c`, `\copy`, `\o`, `\g` with a pipe, `\i`/`\ir`, `\setenv`).
- **Run SQL only inside a container with no network and no host folders.** Start one with `docker run --rm -d --network none -e POSTGRES_PASSWORD=<random> postgres:16` (no `-v`, no other `-e`), copy the migration files in with `docker cp`, and run `psql` inside it with `docker exec`. With no network the container cannot reach a real database, whatever the files or the host's environment say. Never run migration files, `psql` scripts or a migration runner against a server on the host.
- **Test through the project's migration runner only inside such a container** too: put both containers on an internal network (`docker network create --internal <name>`, which has no route outside the host's containers), copy in the repository without `.env` files or other secrets, and install nothing the runner does not already vendor. If that is not possible, test the SQL with `psql` in the container and say in the report that the runner itself was not run (for example, whether it wraps files in transactions).
- If Docker is not available, do not run the migrations at all: say so and list what is untested. Ask the user before pulling a container image or installing a package (Squawk, a driver).
- For a change to an existing table, apply the earlier migrations first, insert
  some rows, then apply yours.
- For RLS, prove isolation. Scratch servers connect as a superuser, which skips
  RLS, so the test passes for nothing unless you switch: create the app role
  `NOSUPERUSER NOBYPASSRLS` as a non-owner (or as the owner if that is how the
  app connects, with FORCE on) and `SET ROLE` to it. Insert rows for two
  tenants, set the tenant to one of them, and show that `SELECT count(*)` on
  each tenant table returns only that tenant's rows and that an `INSERT` for
  the other tenant fails. Then, in a new transaction on the same connection
  without setting the tenant, show that the count is 0.
- If the [Squawk](https://squawkhq.com) migration linter is already installed, lint the migration and fix or justify each finding.
- Stop and remove only the containers you started (`docker rm -f <id>`), never with `pkill`, `killall` or a wildcard.

## Reviewing a schema

Report findings most severe first, each with the table and column, why it
matters and the exact fix (SQL). Severity order: data leaks between tenants or
users, data loss (cascades on history, destructive migrations), integrity gaps
(missing FKs, uniqueness, checks, cross-tenant references), wrong types (money,
time zones), locking risks in migrations, then performance (missing indexes).
Do not pad the list with style preferences, and do not report a problem you
have not checked against the actual DDL.
