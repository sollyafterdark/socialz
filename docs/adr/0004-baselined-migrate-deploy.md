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

1. **Take a `pg_dump` backup of production first, before touching
   anything below.** Baselining and the drift check both read production;
   the backup is the rollback path if either turns up something
   unexpected.
2. **Generate the baseline migration** against the *current*, pre-DB-01
   schema (the 3-value `Role` enum) using `prisma@6.5.0`:
   `prisma migrate diff --from-empty --to-schema-datamodel
   ./libraries/nestjs-libraries/src/database/prisma/schema.prisma
   --script`, saved as the first file under a new `migrations/` directory
   (with `migration_lock.toml`, introduced for the first time — this repo
   has never had one).
3. **Verify zero drift against actual production before marking anything
   applied.** Years of boot-time `db push` may have left production's real
   schema out of sync with what `schema.prisma` declares (`db push` will
   silently skip changes it considers unsafe without `--accept-data-loss`,
   and has been run against production repeatedly with no record of what
   each run actually changed). Run `prisma migrate diff --from-url
   <prod-db-url> --to-schema-datamodel
   ./libraries/nestjs-libraries/src/database/prisma/schema.prisma
   --exit-code` — non-zero exit means production and the baseline
   disagree, and that disagreement must be resolved (reconciled by hand)
   *before* proceeding to step 4, not discovered later via a failed
   `migrate deploy`.
4. Only once step 3 confirms zero drift: mark the baseline applied against
   every real environment via `prisma migrate resolve --applied
   <baseline-name>` — without executing its SQL. This is the standard
   Prisma procedure for adopting migrations against an existing, populated
   database that predates any migration history; skipping it makes the
   first real `migrate deploy` try to recreate tables that already exist.
5. DB-01's `migration.sql` becomes the **second** migration in that now-
   real history, applied for real, for the first time, against a database
   whose baseline is already recorded as applied.
6. Replace the boot-time `prisma-db-push` script with `prisma migrate
   deploy`. It applies only pending migrations, in order, using each
   migration's own SQL (DB-01's CASE-based remap included) — it never
   diffs live state against `schema.prisma` and never needs
   `--accept-data-loss`, because it doesn't generate an unreviewed
   destructive diff at all.
7. **Boot-time failure mode, and recovery.** `pm2-run`'s script chains
   with `&&`: `pm2 delete all || true && <migrate step> && pnpm run
   --parallel pm2 && pm2 logs`. If `prisma migrate deploy` exits non-zero
   at boot, the chain stops before the app process starts — nginx is
   already up (a separate step earlier in `Dockerfile.dev`'s `CMD`), but
   the app itself never does, and `restart: unless-stopped` will keep
   restarting the container into the same failing migration indefinitely
   (not a silent hang — an operator will see the app down). There is no
   automatic rollback: recovery means an operator reads the container
   logs for the failure, and either fixes the migration and redeploys, or
   restores the step-1 `pg_dump` backup and redeploys the previous image.
8. **Sequencing** (this cannot happen inside DB-01 itself — DB-01 is
   application-layer/database-owned; this ADR is deploy/devops-owned).
   Devops' PR #1 (the isolated-stack compose rebuild) has since merged and
   kept `Dockerfile.dev`/the `pm2-run` boot script unchanged — confirmed by
   diff, zero changes to either file — so this ADR's steps apply directly
   against what's running today, not a moving target.
   - A new devops ticket (see backlog, `DEVOPS-01`) implements steps 1–7.
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
- DB-01's rollout timeline is now genuinely dependent on `DEVOPS-01`
  landing — a real sequencing dependency, not paperwork.
- The drift check (step 3) can fail in either direction: it might find
  production is exactly what `schema.prisma` says (clean baseline, proceed
  immediately), or it might surface real divergence accumulated over years
  of `db push` runs that needs a human decision before baselining can
  continue. Budget for the latter — it is not purely mechanical.
