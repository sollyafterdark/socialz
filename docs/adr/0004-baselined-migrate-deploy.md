# ADR-0004: Replace boot-time `prisma db push --accept-data-loss` with baselined `prisma migrate deploy`

**Status:** Accepted
**Date:** 2026-09-15
**Owners:** devops (implementation), database (DB-01's migration is what this unblocks)

## Context

Source: `/code-review ultra` Finding #1 on PR #4 (DB-01), recorded verbatim
at `docs/reviews/2026-09-15-pr4-ultrareview.md`.

Verified directly against `origin/main`:

- Container boot resolves through `Dockerfile.dev`'s `CMD` → `pnpm run pm2`
  → `package.json`'s `pm2-run` script → `pnpm run prisma-db-push`, which is
  `prisma db push --accept-data-loss --schema
  ./libraries/nestjs-libraries/src/database/prisma/schema.prisma`.
- `db push` reconciles the live database directly to whatever
  `schema.prisma` says, with **no migration history and no data remap**.
  `--accept-data-loss` only silences Prisma's warning about columns/tables
  it would drop — it does **not** rescue an enum value being removed out
  from under existing rows. If any `UserOrganization.role` still holds
  `SUPERADMIN` or `USER` (values DB-01's schema change removes from the
  `Role` enum), Postgres raises `invalid input value for enum` and the
  transaction aborts.
- **There has never been a `migrations/` directory in this repo** —
  confirmed by `git ls-tree` returning nothing under
  `.../prisma/migrations` on `main`. The project has only ever used
  `db push` (the stock Postiz/upstream convention). DB-01's
  `migration.sql` is the first real Prisma migration this codebase has
  ever needed, precisely because it's the first schema change that
  requires a data remap (`SUPERADMIN→OWNER`, `USER→EDITOR`, plus fallback
  owner promotions) rather than a pure structural diff.
- Consequence: landing DB-01's migration next to a boot process that still
  runs `db push` makes the migration dead weight. `db push` never reads
  `migrations/` at all — it would hit the enum-cast error above and
  crash-loop the container on the next image rebuild+redeploy containing
  DB-01's schema change, having never run DB-01's remap logic.
- **Scope correction, made during this same review (verified via `docker
  inspect socialz-app` at the PM's request):** the hazard is not "every
  container restart." `socialz-app` has no bind mount of the repository —
  `schema.prisma` is baked into the image at build time. A bare restart of
  the image running today just re-runs `db push` against the same already
  -baked-in (still 3-value) schema — a no-op. The hazard fires specifically
  on **rebuilding** a new image from a tree that includes DB-01's schema
  change, then **redeploying** that image. The underlying mechanism is
  still real and still blocking; only the "fires on every restart" framing
  was too broad.

## Decision

1. **Introduce `migrations/` + `migration_lock.toml` for the first time.**
   Baseline it against production's *current*, pre-DB-01 schema (the
   3-value `Role` enum): capture that state as an initial baseline
   migration, and mark it applied against every real environment via
   `prisma migrate resolve --applied <baseline-name>` — without executing
   its SQL. This is the standard Prisma procedure for adopting migrations
   against an existing, populated database that predates any migration
   history; it cannot be skipped or the first real `migrate deploy` will
   try to recreate tables that already exist.
2. DB-01's `migration.sql` becomes the **second** migration in that now-
   real history, applied for real, for the first time, against a database
   whose baseline is already recorded as applied.
3. Replace the boot-time `prisma-db-push` script with `prisma migrate
   deploy`. It applies only pending migrations, in order, using each
   migration's own SQL (DB-01's CASE-based remap included) — it never
   diffs live state against `schema.prisma` and never needs
   `--accept-data-loss`, because it doesn't generate an unreviewed
   destructive diff at all.
4. **Sequencing** (this cannot happen inside DB-01 itself — DB-01 is
   application-layer/database-owned; this ADR is deploy/devops-owned):
   - Devops' PR #1 (the isolated-stack compose rebuild) merges first — it
     defines the actual production image/boot process this ADR changes.
     Implementing this ADR against the current `Dockerfile.dev`/build
     script would be building against a path PR #1 may replace outright.
   - A new devops ticket (see backlog) implements the baseline + the
     `db push` → `migrate deploy` swap, against whatever image/compose
     PR #1 lands with.
   - **DB-01 is blocked on that ticket, not the reverse.** DB-01's
     `migration.sql` must not be merged/deployed until the boot process
     can actually execute it via `migrate deploy` — merging DB-01 first
     just re-creates the crash-loop hazard this ADR exists to prevent.

## Consequences

- Baselining is a one-time, environment-specific operation — it has to be
  run against whatever production's real current state actually is, so
  the devops ticket needs a runbook step, not just a code change; it
  cannot be fully scripted in the abstract.
- Every schema change from here on follows the same discipline (write a
  migration, `migrate deploy` applies it) — this closes off `db push`'s
  "reconcile to whatever schema.prisma currently says" behavior as a
  production hazard permanently, not just for DB-01's cutover.
- This changes the production deploy path. Per CLAUDE.md's approval
  tiers, it needs project-owner + PM sign-off — the same tier as DB-01
  itself, and for the same underlying reason (both touch how data survives
  a real cutover).
- DB-01's rollout timeline is now genuinely dependent on devops' PR #1
  merging and this new ticket landing — a real sequencing dependency, not
  paperwork.
