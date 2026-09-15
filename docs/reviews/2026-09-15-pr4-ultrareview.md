# `/code-review ultra` results — PR #4 (DB-01 role enum migration)

Run 2026-09-15 against `sollyafterdark/socialz#4`. The review was configured
to post its findings to the PR as a single comment from the user's own
GitHub account; that post failed (GitHub rejected the comment: "your
account cannot comment on this pull request"), so nothing was ever posted
to the PR. This file is the verbatim record of what the review returned,
saved here since the PR comment doesn't exist.

All four findings are reproduced exactly as returned by the review tool —
`pr_comment` (the summary GitHub would have shown) and `reasoning` (the
tool's supporting detail, including its own embedded "Verification:" line)
are pasted verbatim, not paraphrased. My own verification-against-the-
actual-code and in-scope assessment follow each one, clearly marked as
mine.

---

## Finding 1

- **file_path:** `libraries/nestjs-libraries/src/database/prisma/migrations/20260915120000_migrate_role_enum_to_six_roles/README.md`
- **severity:** normal
- **start_line / end_line:** 37 / 47

**pr_comment (verbatim):**

> Container startup path (Dockerfile.dev CMD -> `pnpm run pm2` -> `pm2-run` -> `prisma-db-push --accept-data-loss`) applies the new six-value Role enum via `db push`, bypassing this PR's migration.sql; on any populated DB the generic `USING (role::text::"Role_new")` recast will error on the retired `SUPERADMIN`/`USER` values (which are not in the new enum), breaking the deploy and skipping the SUPERADMIN->OWNER / USER->EDITOR remap and fallback owner promotions that migration.sql exists to perform.

**reasoning (verbatim):**

> Dockerfile.dev's CMD is `sh -c "nginx && pnpm run pm2"`, which resolves through package.json:16-18 to `pm2 delete all || true && pnpm run prisma-db-push && ...` -> `pnpm dlx prisma@ 6.5.0 db push --accept-data-loss --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma`. `db push` is unaware of the `migrations/` directory and always reconciles the live DB to schema.prisma directly. With this PR's enum shift (SUPERADMIN/USER removed, four new values added), Prisma's diff engine emits an `ALTER COLUMN role TYPE "Role_new" USING (role::text::"Role_new")` (or equivalent CREATE+swap) with no CASE remap. `--accept-data-loss` does NOT rescue enum cast errors: as soon as one `UserOrganization` row has `role = 'SUPERADMIN'` or `role = 'USER'`, Postgres raises `invalid input value for enum` and the transaction aborts, so the container's startup script errors and `pnpm run --parallel pm2` never runs (deploy crash-loop). The README acknowledges the general risk on line 45-47 ("`--accept-data-loss` on a shrinking enum risks silently dropping rows that reference retired…
>
> **Verification:** normal — Dockerfile.dev line 29 `CMD ["sh", "-c", "nginx && pnpm run pm2"]` runs package.json `pm2-run` (line 16) `pm2 delete all || true && pnpm run prisma-db-push && ...`, whose `prisma-db-push` (line 36) is `prisma@ 6.5.0 db push --accept-data-loss --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma`. `var/docker/docker-build.sh` builds the deploy image… | normal.…

**My verification:** Confirmed by direct inspection of `Dockerfile.dev`, root `package.json`, and the *running* `socialz-app` container's actual entrypoint (`docker inspect socialz-app`). The container's entrypoint really does resolve to `nginx && pnpm run pm2` → `prisma-db-push --accept-data-loss` on every container start. However, per the PM's question in this same session: `socialz-app` has **no bind mount of the application source** (`docker inspect` shows only `/config`, `/uploads`, and three secret files mounted — no repo path). `schema.prisma` is baked into the image at build time. So this hazard fires on **rebuild-and-redeploy of a new image built from a tree containing this PR's schema.prisma change**, not on a bare restart of the *current* image — a plain restart re-runs `db push` against the same old baked-in schema, which is a no-op. The underlying finding (db push bypasses migration.sql, no CASE remap, would fail on legacy enum values) is real; the "every restart" framing in my original write-up was broader than the actual risk. See item 4 of the PM's questions in this session for the full correction.

**In scope for DB-01:** No — `Dockerfile.dev` and `package.json`'s deploy scripts are devops-owned. Documented in the migration's README and the PR description as a cutover blocker requiring devops coordination; not fixed in this PR.

---

## Finding 2

- **file_path:** `libraries/nestjs-libraries/src/database/prisma/schema.prisma`
- **severity:** normal
- **start_line / end_line:** 944 / 950

**pr_comment (verbatim):**

> Removing SUPERADMIN/USER from the Role enum in schema.prisma breaks `pnpm build` on merge, before the migration ever runs, because `prisma generate` is a postinstall step. [also at: libraries/nestjs-libraries/src/database/prisma/migrations/20260915120000_migrate_role_enum_to_six_roles/README.md:179 - README claim that RBAC-04 code repoint is safe to defer misframes when the compile break lands: it says 'stop compiling the moment this schema change is actually deployed', but root package.json's postinstall runs prisma-generate, so client types regenerate at pnpm install / CI…]

**reasoning (verbatim):**

> Root `package.json` declares `"postinstall": "pnpm run prisma-generate"`, so every `pnpm install` (including CI's `.github/workflows/build.yml` step at line 51) regenerates `@ prisma/client` off this new schema. The regenerated `Role` enum no longer contains `SUPERADMIN` or `USER`, so the six existing references to `Role.SUPERADMIN` (organization.repository.ts:36,366,495; users.repository.ts:143; users.service.ts:90,111) become TS2339-style compile errors during `pnpm run build` (line 54). The README claims these break only "the moment this schema change is actually deployed", but the compile break is triggered by schema.prisma being on `main`, not by migration.sql being applied - so merging DB-01 without also landing RBAC-04's repoint leaves `main` red until RBAC-04 arrives.
>
> **Verification:** normal. schema.prisma at HEAD removes SUPERADMIN/USER from the Role enum (diff lines 942-950). Root package.json declares "postinstall": "pnpm run prisma-generate", so every pnpm install regenerates @ prisma/client against the new schema. .github/workflows/build.yml runs `pnpm install` (line 51) then `pnpm run build` (line 54) on push/pull_request/merge_group. Six live TS call sites still…

**My verification:** Confirmed directly — `package.json`'s `postinstall` script and the six call sites (`organization.repository.ts:36,366,495`, `users.repository.ts:143`, `users.service.ts:90,111`) all match exactly.

**In scope for DB-01:** The wording correction is — fixed in the README (changed "the moment this schema change is actually deployed" to "the next `pnpm install`/CI build"). The actual repoint (fixing the 6 call sites) is RBAC-04's scope, not DB-01's.

---

## Finding 3

- **file_path:** `libraries/nestjs-libraries/src/database/prisma/migrations/20260915120000_migrate_role_enum_to_six_roles/README.md`
- **severity:** normal
- **start_line / end_line:** 173 / 184

**pr_comment (verbatim):**

> README's `6 sites will stop compiling` undercount misses many string-literal role checks; sweep:`["'](SUPERADMIN|USER)["']`; owners get locked out of admin actions post-cutover

**reasoning (verbatim):**

> The README lists only the 6 call sites that import `Role.SUPERADMIN`/`Role.USER` from Prisma and will fail to compile once schema.prisma lands, and defers everything else to RBAC-04. But numerous callsites compare the role via string literals and will silently misbehave after migration.sql remaps `SUPERADMIN→OWNER` and `USER→EDITOR`, with no compile-time signal for RBAC-04 to key off. The most severe one: `apps/backend/src/services/auth/permissions/permissions.service.ts:131` gates `Sections.ADMIN` with `['ADMIN','SUPERADMIN'].includes(permission)`, so every workspace owner (formerly SUPERADMIN row, now `OWNER`) is denied `DELETE /team/:id`, `POST /shortlink`, and every other endpoint decorated with `Sections.ADMIN`, immediately after cutover — workspace owners lose the ability to administer their own workspace. Same pattern also silently changes behavior at `libraries/nestjs-libraries/src/database/prisma/organizations/organization.service.ts:175-176` (level calc: every non-`USER`/non-`ADMIN` role now becomes level 2, breaking the myLevel < userLevel guard once RBAC-04 unblocks…
>
> **Verification:** normal — README lines 177-184 claim only 6 call sites (in 3 files) will stop compiling and defer everything else to RBAC-04, but grep for `["'](SUPERADMIN|USER)["']` surfaces multiple string-literal role checks the deferral silently misses. The load-bearing one is `apps/backend/src/services/auth/permissions/permissions.service.ts:131`: `['ADMIN', 'SUPERADMIN'].includes(permission)` gates… | nit…

**My verification:** Confirmed both call sites exist with the literal text quoted. `permissions.service.ts:42,131` — confirmed, but this one is **already covered** by RBAC-04's existing repoint table in `docs/backlog/2026-09-admin-rbac-v1.md` (row 5: `['ADMIN','SUPERADMIN'].includes(permission)` → `['ADMIN','OWNER'].includes(permission)`), so it is not a gap despite the finding's phrasing. `organization.service.ts:175-176` — confirmed, and this one is **not** in RBAC-04's table. I read the actual function (`deleteTeamMember`): `const myLevel = myRole === 'USER' ? 0 : myRole === 'ADMIN' ? 1 : 2;` (same pattern for `userLevel`). Today only `SUPERADMIN` falls into the `: 2` branch. Post-migration, `OWNER`, `EDITOR`, `CONTRIBUTOR`, `TRANSLATOR`, and `VIEWER` all fall into that same `: 2` branch (none literally equals `'USER'` or `'ADMIN'`), so they all become "level 2" together. The guard `if (myLevel < userLevel) throw` would then never fire between any two of those five roles — e.g., a `VIEWER` could remove an `OWNER` from the workspace. This is a genuine privilege-escalation gap in RBAC-04's own "19 references, checked by hand" audit table.

**In scope for DB-01:** Partially. The README undercount claim is fixed (README now separates "will not compile" from "will silently misbehave," and lists both `permissions.service.ts` and `organization.service.ts`). The actual code fix belongs to RBAC-04/auth-rbac — `organization.service.ts` is security-sensitive, auth-rbac-owned code, not edited in this PR. Flagged for RBAC-04's table to be updated before that ticket is implemented.

---

## Finding 4

- **file_path:** `libraries/nestjs-libraries/src/database/prisma/migrations/20260915120000_migrate_role_enum_to_six_roles/migration.sql`
- **severity:** normal
- **start_line / end_line:** 74 / 93

**pr_comment (verbatim):**

> Rule 2/3 fallback-promotion CTEs pick the earliest UserOrganization row without filtering `disabled = true` or soft-deleted/deactivated users, so workspaces whose earliest ADMIN or member is disabled (e.g., after a paid->free subscription downgrade ran `disableOrEnableNonSuperAdminUsers`) end up post-migration with an OWNER row on a user who cannot log in or act, silently violating ADR-0001's `every non-empty workspace comes out with at least one OWNER` invariant in operational terms.

**reasoning (verbatim):**

> `rule2_ranked` and `rule3_ranked` select from `UserOrganization` filtered only by `role` and `organizationId NOT IN (...)` (migration.sql lines 74-93). They do not join `User` or filter `disabled`, `User.deletedAt`, or `User.activated`. In production, `subscription.service.ts:123,130,186,193` calls `disableOrEnableNonSuperAdminUsers(orgId, true)` (organization.repository.ts:490-501) whenever a team-supporting plan downgrades to a plan without `team_members`, which flips `disabled = true` on every non-SUPERADMIN UserOrganization row in that workspace. In any such workspace whose only SUPERADMIN row was later removed (schema does not enforce SUPERADMIN existence), the workspace now has: 0 SUPERADMIN rows and only disabled ADMIN/USER rows. DB-01 evaluates Rule 2 (or Rule 3), picks the earliest-created ADMIN/member -- disabled or not -- and UPDATEs it to OWNER at Step 3. Post-migration the workspace has exactly one OWNER row for a `disabled=true` (or soft-deleted / not-activated) user who cannot access the workspace; the ADR-0001 invariant that every non-empty workspace has an OWNER…
>
> **Verification:** normal. `migration.sql` lines 74-93 (`rule2_ranked` filters only `role = 'ADMIN'` and excludes orgs with SUPERADMIN; `rule3_ranked` only excludes SUPERADMIN/ADMIN orgs). Neither CTE references `UserOrganization.disabled` nor joins `User` to check `deletedAt`/`activated`. `schema.prisma:144` shows `disabled` exists on `UserOrganization`; `subscription.service.ts:122-127,185-190` calls… | normal —…

**My verification:** Confirmed — the original CTEs had no health filtering, exactly as described. `User.deletedAt` and `User.activated` both already exist on the `User` model (confirmed by reading `schema.prisma`), so the fix was available immediately without waiting on another ticket.

**In scope for DB-01:** Yes — `migration.sql` is this ticket's own file. **Fixed:** `rule2_ranked`/`rule3_ranked` now order candidates by health first (`NOT uo.disabled AND u."deletedAt" IS NULL AND u.activated`, healthy first) then earliest-`createdAt`, falling through to an unhealthy candidate only if no healthy one exists in that workspace (Rule 4's "cannot auto-resolve" still applies only to zero-member workspaces, not zero-*healthy*-member ones). `db-01-pre-migration-report.sql` updated to use the identical ordering and expose a new `auto_promoted_is_healthy` column. Re-validated against a disposable Postgres container with two new fixture cases (earliest-admin-disabled; all-admin-candidates-unhealthy) — migration output matched the report's predictions exactly in both.

---

## Summary of disposition

| # | In scope for DB-01? | Action taken |
|---|---|---|
| 1 | No (devops-owned deploy scripts) | Documented as a cutover blocker in README + PR description; scope corrected per PM's mount-check question (see below) — README now says so |
| 2 | Partial (wording only) | README wording corrected; actual repoint stays RBAC-04's |
| 3 | Partial (wording only) | README restructured to separate compile-breaks from silent-behavior breaks; `organization.service.ts` gap flagged for RBAC-04, not fixed here |
| 4 | Yes | Fixed directly in `migration.sql` and the report script, re-validated |

## Correction applied (raised by PM, 2026-09-15, same session)

Finding 1's framing — and this PR's README as first written — said the `db push --accept-data-loss` hazard fires on "every container start." Checked at the PM's request: `docker inspect socialz-app` shows no bind mount of the repository into the container (only `/config`, `/uploads`, and three secret files are mounted). `schema.prisma` is therefore baked into the image at build time, not read live from disk. A bare restart of the *current* image re-runs `db push` against the same already-baked-in (old, 3-value) schema — a no-op, not a hazard. The hazard requires a **rebuild** of the image from a tree that includes this PR's `schema.prisma` change, followed by redeploying that new image — not a plain restart of what's running today. The underlying mechanism (db push bypassing `migration.sql`, no CASE remap, failure on legacy enum values once real data exists) is still real; only the "every restart" scope of the claim was too broad.

**README corrected** (commit `e7704024`, approved by PM): the section is now titled "Rebuild-and-redeploy bypasses `migration.sql` entirely," states directly that a plain restart of the currently-running image is a no-op, and explains the actual hazard is a rebuild-from-a-tree-with-this-schema-change followed by redeploying that image, before `migration.sql` has been applied.
