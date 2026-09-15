# DB-01: Role enum migration — cutover notes

Implements `docs/adr/0001-two-layer-role-model.md` and DB-01 in
`docs/backlog/2026-09-admin-rbac-v1.md`. This file is documentation only —
nothing here is run automatically, and this migration is **not applied by
this PR** (per CLAUDE.md, database migrations are PR-only and this one
additionally needs project-owner + PM sign-off before it runs, since it's
an auth/RBAC schema change).

## ⚠️ Downtime / locking

**This migration requires a maintenance window on any populated database.**
Step 2 of `migration.sql` runs:

```sql
ALTER TABLE "UserOrganization" ALTER COLUMN role TYPE "Role" USING (...);
```

Postgres cannot do this in place — it rewrites every row of
`UserOrganization` and holds an **ACCESS EXCLUSIVE lock** on the table for
the duration, blocking all reads and writes against it. `UserOrganization`
is on the hot path for nearly every authenticated request (org-switching,
role/permission checks, invite flows), so this is not a safe live
hot-deploy at any real scale.

- Checked against the live `socialz-postgres` database on 2026-09-15: 0
  rows in `UserOrganization`, 0 organizations, 0 users. At this size the
  rewrite is instantaneous. This assessment is about the general case —
  before actually running this against a populated database, re-run the
  pre-migration report (see below) to see the real row count at that time.
- No multi-step application backfill job is needed — the whole thing is
  one SQL statement wrapped in a single transaction, not an
  online/gradual backfill — but the lock duration scales with table size,
  so this still needs a scheduled low-traffic window, not an
  any-time deploy.

## Baselining required before this can run via `prisma migrate`

This repo has managed its schema exclusively with `prisma db push
--accept-data-loss` up to now (see root `package.json`'s `prisma-db-push`
script) — there was no `migrations/` directory before this PR. This is
the first real migration file, introduced deliberately here because this
change moves data (role remapping, fallback owner promotion) in a way
`db push` cannot express or do safely — `db push` has no concept of a data
migration step, and `--accept-data-loss` on a shrinking enum risks
silently dropping rows that reference retired values instead of remapping
them.

Before this file can be applied for real with `prisma migrate deploy`,
the live database needs to be **baselined** into Prisma's migration
history (it doesn't know this schema was reached via `db push`, not a
prior migration):

```sh
pnpm dlx prisma@6.5.0 migrate resolve --applied 20260915120000_migrate_role_enum_to_six_roles \
  --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma
```

run **before** the schema.prisma change in this PR is deployed, against
the *old* schema — i.e. baselining is its own step in the cutover runbook,
not something this PR does. Alternatively, whoever runs the cutover may
choose to apply `migration.sql` directly with `psql` after a verified
backup and skip adopting `prisma migrate` bookkeeping for now — that's a
deliberate operational choice for the owner/PM sign-off conversation, not
decided here.

## Rollback plan

**There is no safe automated down-migration for this file.** The reason
is specific to the fallback-promotion step (Step 3): once a workspace's
earliest ADMIN or earliest member has been promoted to `OWNER` under Rule
2 or Rule 3, that row is indistinguishable in the post-migration data from
a row that was mechanically mapped from a real pre-existing `SUPERADMIN`
(Rule 1). A mechanical reverse mapping (`OWNER` → `SUPERADMIN`, `ADMIN` →
`ADMIN`, `EDITOR` → `USER`) would incorrectly turn every fallback-promoted
user into `SUPERADMIN`, which they never were — and `CONTRIBUTOR` /
`TRANSLATOR` / `VIEWER` have no pre-migration equivalent to revert to at
all once other tickets (RBAC-08, etc.) start assigning them.

Rollback procedure, in order of preference:

1. **Restore from backup.** Required pre-flight, per CLAUDE.md: take a
   verified `pg_dump` of at least `UserOrganization` (a full-database dump
   is simpler to reason about) immediately before this migration is
   applied, and confirm it restores cleanly in a scratch database *before*
   the cutover window opens. If the migration needs to be rolled back,
   restore from that dump. This is the only rollback path that is
   correct by construction.
2. **If no backup is available:** a manual, reviewed reverse mapping is
   possible only by cross-referencing the pre-migration report's saved
   output (which names every fallback-promoted row and which rule fired)
   against the current data, run by a human as a one-off recovery action —
   not a script, and not something to run unattended.
3. Rolling back the schema shape itself (recreating the 3-value enum) is
   mechanically the same operation in reverse, with the same ACCESS
   EXCLUSIVE locking behavior described above — plan the same maintenance
   window for a rollback as for the forward migration.

## Validation performed

`migration.sql` and the report script were both dry-run against a disposable,
throwaway Postgres container (not `socialz-postgres`) seeded with one
workspace per fallback rule (1–4), including two-ADMIN and two-member
workspaces to confirm the *earliest-created* tiebreak. The report
correctly classified all four; the migration correctly produced exactly
one `OWNER` per non-empty workspace, left the zero-member workspace
untouched, and left every other role's mapping exact (`ADMIN`→`ADMIN` for
non-promoted admins, `USER`→`EDITOR` for non-promoted members). The
disposable container was removed after validation; `socialz-postgres` was
only ever touched by the read-only report queries below.

## Code that will not compile once this schema change is deployed

This PR intentionally does not touch application code — that repoint is
RBAC-04's scope (`docs/backlog/2026-09-admin-rbac-v1.md`), which already
has a line-by-line table of every call site. For the record, these 6
references to the retired `Role.SUPERADMIN` / `Role.USER` values will stop
compiling the moment this schema change is actually deployed, matching
RBAC-04's table exactly:

- `organizations/organization.repository.ts:36,366,495`
- `users/users.repository.ts:143`
- `users/users.service.ts:90,111`

Sequencing (DB-01 merges, then RBAC-04 repoints) is the backlog's existing
plan, not something this PR changes — flagged here so it isn't a surprise
at cutover time.

## Pre-migration report

`../../scripts/db-01-pre-migration-report.sql` is the read-only report
required by DB-01: which fallback rule fires per workspace, exactly who
gets auto-promoted under rules 2–4 and why, and a separate list of every
current `SUPERADMIN` row for the owner to decide by hand which should also
get `User.isSuperAdmin = true`. Safe to re-run at any time, including
immediately before the actual cutover, since the live database will have
changed by then. See that file's header for how to run it.
