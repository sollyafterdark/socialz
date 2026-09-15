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
Prisma's migration history needs a **baseline migration** representing
the schema that's already live (Prisma has no record of it — it was
reached via `db push`, never a migration). `prisma migrate resolve
--applied` on *this* PR's migration alone is not enough by itself: run
against a database with no migration history at all, `migrate deploy`
would still try to apply every prior migration file it finds, including
one that doesn't exist yet for the pre-DB-01 schema. The baseline
migration is what fills that gap. Concrete steps, run from the repo root,
**before** merging this PR's schema.prisma change (i.e. against `main` as
it stands today, commit `16af5a91`):

```sh
# 1. Snapshot the schema as it exists on `main` right now (before this
#    PR's Role enum change) into a scratch file — this represents what's
#    already deployed and must NOT include this PR's changes.
git show main:libraries/nestjs-libraries/src/database/prisma/schema.prisma \
  > /tmp/pre-db01-schema.prisma

# 2. Create the baseline migration folder (timestamp must sort BEFORE
#    20260915120000_migrate_role_enum_to_six_roles).
mkdir -p libraries/nestjs-libraries/src/database/prisma/migrations/20260915000000_baseline

# 3. Generate the baseline migration.sql: the full DDL to go from an empty
#    database to the schema already live in production.
pnpm dlx prisma@6.5.0 migrate diff \
  --from-empty \
  --to-schema-datamodel /tmp/pre-db01-schema.prisma \
  --script \
  > libraries/nestjs-libraries/src/database/prisma/migrations/20260915000000_baseline/migration.sql

# 4. Mark the baseline as already applied against the LIVE database,
#    WITHOUT running its SQL (the schema it describes is already there —
#    running it would try to re-create every table and fail):
DATABASE_URL="<production DATABASE_URL>" pnpm dlx prisma@6.5.0 migrate resolve \
  --applied 20260915000000_baseline \
  --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma

# 5. Confirm Prisma now sees the baseline as applied and THIS PR's
#    migration (20260915120000_migrate_role_enum_to_six_roles) as the
#    single next pending migration — nothing else:
DATABASE_URL="<production DATABASE_URL>" pnpm dlx prisma@6.5.0 migrate status \
  --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma
```

Steps 1–5 are one-time, run once against the live database, independent
of this PR's own schema.prisma change (they baseline what's *already*
there). Only after that, with this PR's schema.prisma merged, a verified
backup taken, the maintenance window scheduled, and owner/PM sign-off on
the pre-migration report below, does the actual cutover run:

```sh
DATABASE_URL="<production DATABASE_URL>" pnpm dlx prisma@6.5.0 migrate deploy \
  --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma
```

`migrate deploy` applies pending migrations in filename-timestamp order
inside a single transaction per file, so it will run exactly
`20260915120000_migrate_role_enum_to_six_roles/migration.sql` — the file
reviewed in this PR — and nothing else.

Alternatively, whoever runs the cutover may choose to apply
`migration.sql` directly with `psql` after a verified backup and skip
adopting `prisma migrate` bookkeeping for now, accepting that the next
schema change will face this same baselining step again. That's a
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
non-promoted admins, `USER`→`EDITOR` for non-promoted members). Re-run
against a second fresh disposable container after adding the explicit
`LOCK TABLE` statement (see below) — same fixture, identical results.

Re-run a third time on a third fresh disposable container, fixture
extended with two health-preference cases (from ultrareview's fallback-
selection finding, addressed below): a workspace whose earliest ADMIN is
`disabled` (correctly skipped in favor of the later, healthy ADMIN), and
a workspace where every ADMIN candidate is unhealthy — one soft-deleted,
one deactivated (correctly still promotes the earliest of the two rather
than leaving the workspace ownerless, exactly matching Rule 2's "cannot
be auto-resolved" carve-out being reserved for Rule 4 alone). The report
script's predicted `auto_promoted_user_id`/`auto_promoted_is_healthy` per
workspace matched the migration's actual output exactly in every case.

All three disposable containers were removed after validation;
`socialz-postgres` was only ever touched by the read-only report queries
below.

`migration.sql` also takes an explicit `LOCK TABLE "UserOrganization" IN
ACCESS EXCLUSIVE MODE` immediately after `BEGIN`, before Step 1 reads the
table. Step 2's `ALTER TABLE ... TYPE ...` would acquire this same lock
implicitly when it gets there regardless, but taking it up front closes
the small window between Step 1's read and Step 2's ALTER during which
another transaction could otherwise insert or update a row — making the
fallback computation and the migrated data agree by explicit construction
rather than by incidental statement ordering.

## ⚠️ Deploy path bypasses `migration.sql` entirely — found by ultrareview, verified

**Found by `/code-review ultra`, confirmed by direct inspection of the live
`socialz-app` container.** The running container's entrypoint (`docker
inspect socialz-app`) exports `DATABASE_URL` from secrets and then runs
`exec sh -c 'nginx && pnpm run pm2'`, which resolves through
`Dockerfile.dev`'s `CMD` and root `package.json` to:

```
pm2-run: pm2 delete all || true && pnpm run prisma-db-push && pnpm run --parallel pm2 && pm2 logs
prisma-db-push: pnpm dlx prisma@6.5.0 db push --accept-data-loss --schema ./libraries/.../schema.prisma
```

**This runs on every container start** (deploy, crash restart, host
reboot) — not just the first one. `db push` reconciles the live database
directly to whichever `schema.prisma` is in the image; it has no concept
of `migrations/` and will not run `migration.sql`'s CASE-based remap or
fallback-owner logic. Its generated `ALTER COLUMN ... TYPE ... USING
(role::text::"Role_new")` has no mapping for `SUPERADMIN`/`USER`, so on a
database that still has any row in those values, the cast raises `invalid
input value for enum` and the whole `&&` chain aborts before
`pnpm run --parallel pm2` ever runs — the app processes never start.
Postgres aborts the failed statement's transaction atomically, so this
fails as a hard outage (container won't come up) rather than as silent
data corruption — but it is still a self-inflicted outage this PR must
not walk into blind.

**This means merging this PR's `schema.prisma` change is not enough by
itself, and the ordering matters:** `migration.sql` (via the baselined
`prisma migrate deploy` above, or a manual `psql` apply after backup)
**must be applied before the next `socialz-app` container restart of any
kind** — not just before some notional "cutover" — because that restart
will run `db push --accept-data-loss` regardless of whether anyone
intended a deploy that day. If `migration.sql` has already been applied
by the time `db push` runs, the live schema already matches
`schema.prisma` and `db push` is a no-op for the `Role` enum; nothing
extra happens. On the current, empty `socialz-postgres` (0
`UserOrganization` rows) this specific crash can't fire today — there's
no `SUPERADMIN`/`USER` value for the cast to fail on — but that stops
being true the moment real workspaces exist, and this hazard needs a real
fix before then. **Out of DB-01's scope** (`Dockerfile.dev` and
`package.json`'s deploy scripts belong to the devops stream), flagged
here as a hard blocker for the actual cutover, not something this PR can
resolve by itself. Recommend devops add a migration-status check (or gate
`prisma-db-push` behind `prisma migrate status`) before RBAC-04's cutover
window, not merely reorder the manual steps by hand.

## Code that will not compile — and code that will silently misbehave

This PR intentionally does not touch application code — that repoint is
RBAC-04's scope (`docs/backlog/2026-09-admin-rbac-v1.md`), which already
has a line-by-line table of every call site. Two distinct categories,
both found by direct inspection (the second sharpened by `/code-review
ultra`):

**Will fail to compile** the moment this schema lands on `main` — root
`package.json`'s `"postinstall": "pnpm run prisma-generate"` means every
`pnpm install` (including CI's `build.yml`, not just an actual database
deploy) regenerates `@prisma/client` against the new enum. These 6
references to the retired `Role.SUPERADMIN` / `Role.USER` enum members
stop compiling at that point, matching RBAC-04's table exactly:

- `organizations/organization.repository.ts:36,366,495`
- `users/users.repository.ts:143`
- `users/users.service.ts:90,111`

**Will silently misbehave, with no compile signal at all** — code that
compares `role` against a string literal typed as a plain string union
rather than importing the `Role` enum, so it keeps compiling fine while
quietly doing the wrong thing once the migration runs:

- `apps/backend/src/services/auth/permissions/permissions.service.ts:42,131`
  — `['ADMIN', 'SUPERADMIN'].includes(permission)`. Already in RBAC-04's
  repoint table (row 5) as `['ADMIN', 'OWNER']` — covered, not a gap.
- `libraries/.../organizations/organization.service.ts:175-176`
  (`deleteTeamMember`) — **found by `/code-review ultra`, not in RBAC-04's
  existing 19-reference table, and genuinely security-relevant:**
  ```
  const myLevel = myRole === 'USER' ? 0 : myRole === 'ADMIN' ? 1 : 2;
  const userLevel = userRole === 'USER' ? 0 : userRole === 'ADMIN' ? 1 : 2;
  if (myLevel < userLevel) { throw ... }
  ```
  Today only `SUPERADMIN` falls into the `: 2` branch, so this correctly
  stops a lower-role user from removing a higher one. After this
  migration, `OWNER`, `EDITOR`, `CONTRIBUTOR`, `TRANSLATOR`, and `VIEWER`
  *all* fall into that same `: 2` branch (none of them literally equal
  `'USER'` or `'ADMIN'`), so they all become equally "level 2" — a
  `VIEWER` (`myLevel` 2) could remove an `OWNER` (`userLevel` 2), since
  `2 < 2` is false and the guard never fires. **This is a privilege-
  escalation gap RBAC-04's own repoint table missed and must add before
  that ticket is implemented** — flagging it here rather than fixing it
  myself, since `organization.service.ts` is auth-rbac-owned, security-
  sensitive code, not database's to edit.

Sequencing (DB-01 merges, then RBAC-04 repoints, informed by the gap just
found) is the backlog's existing plan, not something this PR changes —
flagged here, and in the merge-instruction section of the PR description,
so none of this is a surprise at cutover time.

## Pre-migration report

`../../scripts/db-01-pre-migration-report.sql` is the read-only report
required by DB-01: which fallback rule fires per workspace, exactly who
gets auto-promoted under rules 2–4 and why, and a separate list of every
current `SUPERADMIN` row for the owner to decide by hand which should also
get `User.isSuperAdmin = true`. Safe to re-run at any time, including
immediately before the actual cutover, since the live database will have
changed by then. See that file's header for how to run it.
