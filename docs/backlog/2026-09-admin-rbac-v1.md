# V1 Backlog: Role model + Admin/Platform Admin dashboards

Source: project owner's consolidated decision, 2026-09-15 (supersedes the
interactive-picker partial answers from the same session). Structural
decisions are recorded in `docs/adr/0001`–`0003`; this doc breaks the work
into PR-sized tickets. Each ticket is meant to land as one PR, reviewed via
the standard Code Review pass + project-owner/PM sign-off before merge to
`main`, per CLAUDE.md.

**Approval tier:** every ticket below touches auth/RBAC and/or a database
migration → all of it needs project-owner + PM sign-off before merge, per
CLAUDE.md's approval tiers. None of it is review-stream-only.

## Verified adopt-as-is (do not re-ticket)

Checked against the current codebase before writing tickets, per the
brief's "verify before ticketing as new work" instruction:

- **Multi-workspace membership + switcher** — a user can already belong to
  several organizations and switch between them
  (`apps/frontend/src/components/layout/organization.selector.tsx`,
  `GET /user/organizations`, `POST /user/change-org`). Confirmed working
  as-is; no ticket needed.
- **Invite by email, new or existing user** — `organization.service.ts`
  already has both `inviteTeamMember` (new user, signed-JWT email link) and
  `addTeamMemberByEmail` (existing Postiz account, added directly). Confirmed
  working as-is. The one real gap: both paths currently only accept
  `'USER' | 'ADMIN'` as the role — see RBAC-08 below, which extends the
  existing flow rather than replacing it.
- **User impersonation ("Login As")** — `docs/ui-vision.md`'s "Additional
  recommended features" list asks for this; it's already fully built —
  `GET/POST /user/impersonate` and `POST /user/switch`
  (`users.controller.ts`), correctly gated on the global `user.isSuperAdmin`
  flag (i.e. already Platform-Admin-scoped, not a per-workspace concept).
  No ticket needed. (A different, unrelated impersonation-search endpoint
  on the *public API* had a real access-control gap — see RBAC-04's table.)

---

## DevOps tickets (deploy safety — read this before DB-01)

Both found during `/code-review ultra` on PR #4 (DB-01). Both block DB-01
being merged/deployed, not the other way around — see each ticket and
ADR-0004.

### DEVOPS-01 — Baseline migrations, replace boot-time `db push` with `migrate deploy`
Implements ADR-0004. This repo has never had a `migrations/` directory —
boot has only ever run `prisma db push --accept-data-loss`, which
reconciles the live DB straight to `schema.prisma` with no data remap.
DB-01's `migration.sql` is the first real migration this project has
needed, and `db push` doesn't read `migrations/` at all — left as-is, the
next image rebuild+redeploy containing DB-01's schema change crash-loops
the container the moment it hits a row still holding `SUPERADMIN`/`USER`
(removed from the enum), because `--accept-data-loss` doesn't rescue an
enum-cast failure.
Full runbook is now in ADR-0004 (amended 2026-09-16 per PM review): take a
`pg_dump` backup first, generate the baseline with `prisma migrate diff
--from-empty --to-schema-datamodel` (prisma@6.5.0), verify **zero drift**
against actual production with `prisma migrate diff --from-url <prod>
--to-schema-datamodel <schema> --exit-code` *before* `migrate resolve
--applied` (years of boot-time `db push` may have left drift `schema.prisma`
doesn't capture), then swap `pm2-run`'s `prisma-db-push` step for `prisma
migrate deploy`. ADR-0004 also specifies the boot-failure recovery path if
`migrate deploy` ever fails at container start.
**Depends on:** Nothing outstanding — PR #1 merged 2026-09-16 and kept
`Dockerfile.dev`/`pm2-run` unchanged (confirmed by diff), so this ticket
is unblocked and can be picked up now.
**Blocks:** DB-01 (must not merge/deploy DB-01's migration until boot can
actually run it via `migrate deploy` instead of bypassing it via
`db push`).

### DEVOPS-02 — Dedicated, pinned production deploy checkout — **Done**
**Status, 2026-09-16 — resolved, not just proposed.** The incident this
ticket was written for (the live stack's config path holding upstream's
compose file because a feature branch was checked out there) is resolved.
`name: socialz` shipped explicitly in the compose file via PR #7 (merged).
`/home/steve/socialz` is now the dedicated deploy-only checkout, pinned to
`main` — no stream works there anymore (the database stream and this
Architect stream both moved to their own worktrees). Deploys are manual:
from that folder, after a reviewed PR merge, with a `pg_dump` backup taken
first. There is no CI/CD deploy. The operational rule is now written into
`docs/CHARTER.md` §4, which previously described a self-hosted-runner
deploy-on-merge pipeline that did not reflect reality — corrected in the
same pass. Nothing left open on this ticket.
**Depends on:** Nothing — PR #1 and PR #7 both merged.

---

## Database tickets

### DB-01 — Migrate `Role` enum to the six-role workspace model
Implements ADR-0001. Change `Role` enum on `UserOrganization` from
`{SUPERADMIN, ADMIN, USER}` to `{OWNER, ADMIN, EDITOR, CONTRIBUTOR,
TRANSLATOR, VIEWER}`. Data migration: `ADMIN`→`ADMIN`, `USER`→`EDITOR`,
`SUPERADMIN`→`OWNER`.

**Zero-`SUPERADMIN`-workspace fallback (required, per ADR-0001 — this was a
real bug in the original ticket draft):** the mechanical mapping above
only produces an `OWNER` in workspaces that already had a `SUPERADMIN`
row. Nothing in the current schema guarantees every workspace has one.
Any workspace that doesn't must get an explicit fallback owner, applied in
this order and **listed in the report, not applied silently**:
1. Had `SUPERADMIN` → maps to `OWNER` (the default case above).
2. No `SUPERADMIN`, has an `ADMIN` → promote that workspace's
   earliest-created `ADMIN` to `OWNER`.
3. No `SUPERADMIN`, no `ADMIN` → promote the workspace's earliest-created
   member (any role) to `OWNER`.
4. Zero members → cannot auto-resolve; report it, don't guess.

The pre-migration report must therefore cover, per workspace: which rule
fired (1–4), and for rules 2–4, exactly which user was auto-promoted and
why — so the project owner can review every non-obvious promotion, not
just the rule-1 cases. Also still needed, as before: rows currently
`SUPERADMIN` so the owner can decide by hand which of those users should
additionally get `User.isSuperAdmin = true` (Platform Admin) — that
decision stays manual, ADR-0001 does not automate it. Include a rollback
plan.
**Blocked on:** DEVOPS-01 (per ADR-0004 — do not merge/deploy this
migration until boot runs `prisma migrate deploy` instead of `db push`;
merging DB-01 first reintroduces the crash-loop hazard DEVOPS-01 exists to
prevent).
**Blocks:** RBAC-01 through RBAC-08.

### DB-02 — Contributor approval state on `Post`
New field(s) on `Post` for the Contributor→Editor/Admin/Owner approval
gate. Explicitly additive, not a reuse of `submittedForOrderId` /
`approvedSubmitForOrder` (those belong to the unrelated Orders/marketplace
feature — see ADR-0001). Minimal shape: something like
`requiresApproval: Boolean` set at creation time from the author's role,
plus an approval-state value distinct from the existing `State` enum (don't
overload `DRAFT`, which already means something in the publish pipeline).
Exact field design is this ticket's call.
**Blocks:** RBAC-03.

### DB-03 — Account soft-delete + purge job, with soft-transfer of authored content
Implements ADR-0002 for `User`. Reuses existing `User.deletedAt` (no new
column for the soft-delete itself). Build the purge job as a reusable
helper, not one-off per model, since DB-05 needs the same scheduling
pattern for `Post` — but note the two purges have different *outcomes* (see
below and ADR-0002), so the helper must be parameterized, not identical
logic.

**Resolved: Soft Transfer.** When a workspace member's account is removed,
their content is not touched, cancelled, or reassigned automatically —
`Post.authorId` keeps pointing at the removed user's `User` row. A
workspace admin can later reassign orphaned content to another active
member as an explicit action.

**This ticket must add `Post.authorId` — it does not currently exist.**
The `Post` model today has no author/creator reference to `User` at all
(only `organizationId` and `integrationId`). Add it as a nullable
`authorId: String?` (nullable because pre-existing posts and some
`creationMethod` values like API/MCP may have no clear single author) with
a relation to `User`. **Coordinate with DB-02**, which lands around the
same time and also modifies `Post` — sequence or combine the two
migrations so they don't conflict.

**Purge behavior (per the ADR-0002 amendment):** the recurring purge job
for `User` does **not** hard-delete the row 30 days after `deletedAt`. It
anonymizes it instead — replace name/email/avatar/other PII with a
placeholder, set a `purged`/anonymized flag — and keeps the row alive so
`Post.authorId` never points at a missing row. This is what makes the two
UI states resolvable:
- Account removed from this workspace, but the `User` row is intact
  elsewhere / not yet purged → UI shows **"Jane Doe (Former Member)"**.
- Account has been purged (anonymized) → UI shows **"Deactivated User"**.
(Actual label rendering is UI-02/UI-05's job; this ticket only needs to
expose the two states — `deletedAt` set vs. anonymized flag set — for them
to read.)

**Applies to all content states, not just published posts.** A removed
Contributor's unapproved draft, or a removed member's still-scheduled
post, gets the identical soft-transfer treatment — it is **not**
auto-cancelled. (This is distinct from DB-05's cancel-on-removal behavior,
which only applies when *content itself* is explicitly soft-deleted by an
admin, not when its author's account is removed. Don't conflate the two.)

**Admin-reassignment of orphaned content** is an auditable action per
ADR-0003 (added to that ADR's action list) — the reassignment endpoint
itself belongs in auth-rbac's RBAC-05, but depends on the `authorId` field
this ticket adds.
**Blocks:** RBAC-05 (reassignment endpoint depends on `Post.authorId`).
**Coordinate with:** DB-02 (concurrent `Post` schema changes).

### DB-04 — `AuditLog` model
Implements ADR-0003. New model: actor `userId`, scope (workspace-scoped vs.
platform-scoped — must be distinguishable), action type, target type + id,
metadata, timestamp. Plus a shared write-helper service other tickets call
into (RBAC-01 through RBAC-06 all depend on this existing first).

**Must also denormalize identifying details of actor and target onto the
log row itself** (e.g. `actorName`/`actorEmail`, `targetName`/`targetEmail`
as plain text fields, snapshotted at write time) — not solely a `userId`
foreign key. Reason: once ADR-0002's purge job anonymizes a `User` row, an
audit entry that only holds that row's id loses the human-readable context
of what happened — the entire point of the log existing. The FK stays (for
joins while the referenced row is still intact), the snapshot text is what
survives after anonymization.
**Blocks:** RBAC-01, RBAC-02(approval actions), RBAC-04, RBAC-05, RBAC-06.

### DB-05 — Content soft-delete purge job
Implements ADR-0002 for `Post`. `Post.deletedAt` already exists and is
already indexed — this ticket is primarily the purge job, reusing DB-03's
helper. Confirm cancellation of any pending BullMQ publish job tied to a
soft-deleted post (so "removed" content genuinely can't post) as part of
the same removal path, not the purge path — it must stop working
immediately on soft-delete, not wait 30 days.

---

## auth-rbac tickets

### RBAC-01 — Owner role: promote/demote + last-owner invariant
Endpoints for any `OWNER` to promote a workspace member to `OWNER` or
demote an `OWNER` to `ADMIN`. Reject any operation that would leave a
workspace with zero `OWNER`s. Audit-log every promote/demote (needs DB-04).
**Depends on:** DB-01, DB-04.

### RBAC-02 — Role-based content permission guard
New guard/decorator (separate from the CASL `Sections`/billing layer —
confirmed that layer is subscription-tier-only, not content permissions)
mapping the six workspace roles to content actions: create, edit, publish,
approve, delete, view. `CONTRIBUTOR` gets create/edit but not publish.
**Depends on:** DB-01.

### RBAC-03 — Contributor submit-for-approval / Admin approve-reject
Backend endpoints: Contributor submits content for approval; Admin/Editor/
Owner approves (publishes) or rejects (back to Contributor with a reason).
State transitions only — the review-queue UI is UI-06.
**Depends on:** DB-02, RBAC-02.

### RBAC-04 — Platform Admin: promote/demote + repoint every `SUPERADMIN` call site
Implements ADR-0001's platform layer. Promote/demote endpoints on
`User.isSuperAdmin` with the same last-remaining-holder invariant as
RBAC-01, scoped globally.

**Security-sensitive — the repoint table below must ship in the PR itself,
reviewed line by line before merge, not trusted to have been done
correctly after the fact.** A guard repointed to the wrong check is either
a privilege escalation or an accidental lockout. Verified by direct code
inspection (2026-09-15) — every current reference to the org-scoped
`SUPERADMIN` concept, and what it must become once DB-01 removes that enum
value:

| # | Location | What it does | Resolves to |
|---|---|---|---|
| 1 | `super.admin.guard.ts` (`SuperAdminGuard`, checks `hasSuperAdminUser(org.id)`) | Guard class — confirmed by grep its *only* call site anywhere in the codebase is #2 | **Delete**, along with `organization.service.ts#hasSuperAdminUser` and `organization.repository.ts#getSuperAdminUser` (also unused elsewhere once this lands). Replaced by a real check — see resolution below. |
| 2 | `public.integrations.controller.ts:385` (`GET /public-api/v1/integrations/users`) | Public-API impersonation-search endpoint | **Real fix, not a rename — see resolution below.** |
| 3 | `public.auth.middleware.ts:40` | Synthesizes `req.org` for OAuth-token (`pos_...`) public-API callers, hardcodes `role: 'SUPERADMIN'` | `role: 'OWNER'` for the org-permission fake (unrelated to #2's fix), **plus**: this is the one public-API auth path with a real user behind it (`OAuthAuthorization.userId`) — must additionally resolve that user and attach `isSuperAdmin` to the request for #2's new check to read. |
| 4 | `public.auth.middleware.ts:58` | Same, for plain org-`apiKey` public-API callers | `role: 'OWNER'` for the fake. **No user to attach — a static org API key has no associated human user at all** (confirmed: `getOrgByApiKey` only ever looks up `Organization`, nothing else). This is *why* #2 must reject this auth mode outright, not just check-and-pass. |
| 5 | `permissions.service.ts:42,131` | CASL billing gate: `Sections.ADMIN` allowed when `['ADMIN','SUPERADMIN'].includes(permission)` | `['ADMIN','OWNER'].includes(permission)` |
| 6 | `permissions.guard.ts` | Passes `org.users[0].role` into #5 | No logic change — just carries the new enum value through |
| 7 | `users.controller.ts:135` (`GET /user/self`, `publicApi` field) | Only exposes `org.apiKey` to the frontend for Admin-or-higher | `role === 'OWNER' \|\| role === 'ADMIN'` |
| 8 | `users.controller.ts` `getImpersonate`/`setImpersonate`/`switchUser` (~150–200) | The real cross-org impersonation feature | **No change** — already gated on `user.isSuperAdmin` (global), already correct as Platform Admin |
| 9 | `stripe.service.ts:221` | Resyncs Stripe customer email after a login switch; comment already says "Owner-only" | `role === 'OWNER'` |
| 10 | `organization.repository.ts:36` (`createMaxUser`) | Creator of an internal max-tier org becomes its owner | `role: Role.OWNER` |
| 11 | `organization.repository.ts:366` (`createOrgAndUser` — **the standard signup flow**) | Every new org's creator becomes its owner | `role: Role.OWNER` |
| 12 | `organization.repository.ts:495` (`disableOrEnableNonSuperAdminUsers`) | Protects the org's owner from being disabled along with the rest of the org | `role: { not: Role.OWNER } }` |
| 13 | `users.repository.ts:~130` (`getUserWithActiveSubscriptionByEmail`) | Signup/login dedupe: finds an existing paid workspace owned by this email | `role: Role.OWNER` |
| 14 | `users.service.ts:90` (`getOrgsToDeleteForAccount`) | Self-account-deletion: which orgs does this user *own* (fully delete) vs. just leave | `role === Role.OWNER` |
| 15 | `users.service.ts:111` (`deleteAccount`) | Same function, deletion branch | `role === Role.OWNER` |
| 16 | `organization.selector.tsx:82,94` | Org-switcher dropdown display label | `role === 'OWNER'`, label "Owner" |
| 17 | `user.context.tsx:15,28` | Frontend `User`/role TS type definitions | Full six-role union |
| 18 | `top.menu.tsx:191,250,273,303` | Nav-item visibility (media agent, affiliate link, billing, settings) per role array | Replace `'SUPERADMIN'` with `'OWNER'` in each array — **and revisit whether `EDITOR`/`CONTRIBUTOR`/`TRANSLATOR`/`VIEWER` should also see each item; don't just find-and-replace the string.** Cross-check against UI-01/UI-02. |
| 19 | `teams.component.tsx:113,115-116,122,183` | Team-management "can I act on this member" level comparison (`myLevel`/`getLevel`, :113/:115-116), the type it's typed against (:122), and a role display-label fallback (:183: `p.role === 'USER' ? … : p.role === 'ADMIN' ? … : t('super_admin', 'Super Admin')`) — all a 3-bucket scale (`USER`<`ADMIN`<everything else) | Needs a real 6-level hierarchy, not a rename — this is UI-02's scope already; flag the coupling here so it isn't built twice. Same defect as #20 below (identical bug shape to `organization.service.ts:175-176` — build one canonical hierarchy, don't duplicate it frontend/backend). :183 is a display bug specifically: post-migration it would label `OWNER`, `EDITOR`, `CONTRIBUTOR`, `TRANSLATOR`, and `VIEWER` all as "Super Admin." (Corrected from the prior pass, which cited only :115,122 and missed the actual buggy :113 line and the :183 display bug — found by the full `SUPERADMIN\|USER` sweep, 2026-09-15.) |
| 20 | `organization.service.ts:175-176` (`deleteTeamMember`) | The backend's own "can I remove this member" level-gate: `myLevel = myRole === 'USER' ? 0 : myRole === 'ADMIN' ? 1 : 2` (same shape for `userLevel`); only throws if `myLevel < userLevel` | **Real bug — found by `/code-review ultra` on PR #4, not a rename.** **Primary authorization rules first (PM-specified, 2026-09-16) — the level check below is a secondary guard sitting behind these, not the primary mechanism:** only `OWNER` or `ADMIN` may remove a member at all; only an `OWNER` may remove or demote another `OWNER`; the last remaining `OWNER` in a workspace can never be removed (ADR-0001's core invariant); a user removing *themself* goes through this identical last-`OWNER` rule, not a separate self-removal path. Implement those checks explicitly, don't rely on the level map alone to encode them. **Then, the level-map defect itself:** post-migration, `OWNER`, `EDITOR`, `CONTRIBUTOR`, `TRANSLATOR`, and `VIEWER` all fall into the `: 2` branch together (none of them literally equals `'USER'` or `'ADMIN'`), so the guard never fires between any two of those five — concretely, a `VIEWER` could remove an `OWNER` from the workspace if only the level check existed. Needs a full 6-value map, not a 3-branch ternary. **Correct ordering:** `OWNER=5, ADMIN=4, EDITOR=3, CONTRIBUTOR=2, TRANSLATOR=1, VIEWER=0` — matches the order the roles were given in the owner's original consolidated decision, and as a strict total order (no two roles share a level) it makes `myLevel < userLevel` alone sufficient to block a lower role from acting on a higher one, `OWNER` included (`ADMIN`'s 4 `< OWNER`'s 5 already throws — no separate special-case guard needed, though the primary rules above must still be enforced explicitly, not left implicit in the level ordering). Same defect, same fix, exists in `teams.component.tsx` (#19) — build one canonical role-hierarchy constant/helper and have both call it, rather than two independently-maintained copies of the same ranking drifting apart. |

**Resolution on #1/#2 (owner decision, 2026-09-15): fix the access-control
gap for real, don't preserve it.** `PublicAuthMiddleware` currently fakes
`role: 'SUPERADMIN'` for *every* authenticated public-API caller, so
`SuperAdminGuard`'s org-scoped check always passes regardless of who's
calling — the impersonation-search endpoint is not actually restricted to
platform admins today. Repointing the guard to check `OWNER` instead would
preserve that same always-passes hole under a new name. Instead:

- **OAuth-token (`pos_...`) callers:** these do have a real user behind
  them (`OAuthAuthorization.userId` — confirmed via schema). Add
  `include: { user: { select: { id: true, isSuperAdmin: true } } }` to
  `OAuthRepository#findByAccessToken` (it doesn't currently load this
  relation), have `PublicAuthMiddleware` attach it to the request, and
  gate `GET /public-api/v1/integrations/users` on that real
  `user.isSuperAdmin` — not on anything org-scoped.
- **Plain org-`apiKey` callers:** no user identity exists in this auth
  mode at all — there is structurally nothing to check. Reject these
  outright (403) on this one route.
- **Delete** `SuperAdminGuard`, `hasSuperAdminUser`, `getSuperAdminUser`
  (dead code once this lands — #1). New guard name/shape (e.g.
  `PlatformAdminGuard` reading the request-attached real user) is
  auth-rbac's implementation call.
- **Accepted consequence, explicitly signed off by the owner:** any
  existing caller reaching this endpoint via a plain org API key, or via
  an OAuth token belonging to a non-`isSuperAdmin` user, will start
  getting 403s. That's the fix working as intended, not a regression to
  work around.
**Depends on:** DB-01, DB-04.

### RBAC-05 — Account removal (suspend + soft-delete) + content reassignment
Two scopes sharing one implementation: workspace Owner/Admin can
suspend/remove members of their own workspace; Platform Admin can do the
same for any account in any workspace. Calls DB-03's soft-delete path.
Audit-logged.

Also includes the **admin-reassignment endpoint for orphaned content**
that DB-03's soft-transfer design requires: lets a workspace Owner/Admin
(or Platform Admin, any workspace) reassign a removed member's content —
`Post.authorId` — to another active member. Depends on `Post.authorId`
existing (added by DB-03). Audit-logged as its own action per ADR-0003,
distinct from the account-removal audit entry.
**Depends on:** DB-03, DB-04, RBAC-01, RBAC-04.

### RBAC-06 — Content removal (soft-delete)
Same two-scope pattern as RBAC-05, for `Post`. Audit-logged.
**Depends on:** DB-05, DB-04, RBAC-02, RBAC-04.

### RBAC-07 — Restore endpoints
Clears `deletedAt` on accounts/content within the 30-day window. Same
scoping as the corresponding removal ticket. Audit-logged (restore is
itself an admin action worth recording).
**Depends on:** RBAC-05, RBAC-06.

### RBAC-08 — Extend team invite to the full role list
`AddTeamMemberDto` / `AdminAddTeamMemberDto` currently hardcode
`'USER' | 'ADMIN'`. Extend to the six-role list from DB-01, with the
obvious constraint that only an `OWNER` can grant `OWNER`. This extends the
existing, already-working invite flow (see "verified adopt-as-is" above) —
do not rebuild invite-by-email itself.

**Additional sites found by the full `SUPERADMIN|USER` string-literal
sweep (2026-09-15, run for RBAC-04) that this ticket's original scope
missed** — same "only USER/ADMIN" limitation, not previously named here:
- `auth.service.ts:40` (`routeAuth`'s `addToOrg` param type) and `:128`
  (`getOrgFromCookie`'s decoded-JWT return type) — the invite-*acceptance*
  side of the same flow (decoding the signed invite link), not just the
  DTOs on the invite-*sending* side.
- `organization.repository.ts:302` and `organization.service.ts:45,152`
  (`addUserToOrg`'s role param, `addTeamMemberByEmail`'s `body.role as`
  cast) — the repository/service layer the DTOs above ultimately call
  into.
- `teams.component.tsx:24` (`roles` array feeding the invite form's
  `<Select>`) and `impersonate.tsx:769` (a second, separate "add team
  member" form with its own hardcoded `<option value="USER">`/`"ADMIN"`
  pair) — two independent frontend role-pickers, not one.
**Depends on:** DB-01.

---

## ui-ux tickets

### UI-01 — Per-workspace admin dashboard shell
New nav entry + route, visible only to `OWNER`/`ADMIN` of the current
workspace. Tabs: billing, users, settings — scoped to that workspace only,
other members never see it.
**Depends on:** RBAC-02.

### UI-02 — Workspace member management screen
List members + roles, change a member's role (six-role dropdown,
permission-gated per RBAC-08's grant rules), suspend/remove a member,
promote/demote `OWNER`. Lives inside UI-01's shell.
**Depends on:** RBAC-01, RBAC-05, RBAC-08.

### UI-03 — Platform Admin console shell
Separate route/nav, visible only to Platform Admins (`User.isSuperAdmin`).
Global workspace list, drill into any workspace. Per ADR-0001's naming
rule: **never call this "Org [anything]" in copy or route names** — it's
the "Platform Admin" console throughout.
**Depends on:** RBAC-04.

### UI-04 — Platform Admin: account/workspace actions
Suspend or soft-delete any account or workspace from the console; promote/
demote Platform Admin. Lives inside UI-03's shell.
**Depends on:** RBAC-04, RBAC-05.

### UI-05 — Content moderation view + restore
List/search content (workspace-scoped in UI-01, platform-wide in UI-03),
soft-delete action, and a restore action for anything still inside the
30-day window.
**Depends on:** RBAC-06, RBAC-07.

### UI-06 — Contributor approval UI
Compose-flow "submit for approval" action for Contributors; a review queue
(approve/reject with reason) for Admin/Editor/Owner. This is the UI half of
RBAC-03, deliberately split out per the brief ("the approval UI can be its
own ticket").
**Depends on:** RBAC-03.

### UI-07 — Extend existing admin/stats + admin/errors into the new console
Per instruction: extend, don't rebuild. Move/link the existing
`admin-stats.component.tsx` / `admin-errors.component.tsx` screens into the
UI-03 Platform Admin console shell rather than leaving them as standalone
routes.
**Depends on:** UI-03.

### UI-08 — Audit log viewer
Read-only view of `AuditLog` (DB-04): workspace-scoped for Owner/Admin
inside UI-01, platform-wide inside UI-03.
**Depends on:** DB-04, UI-01, UI-03.

### UI-09 — Branding swap
Replace Postiz logo assets with the project owner's; add the owner's ABN
(placement TBD — footer or a settings/legal page is the obvious default,
confirm with owner). Single overall brand only, no per-client
white-labeling, no new UI theme or layout redesign — explicitly deferred to
a later phase, must not block or get bundled with the RBAC/admin work
above.
**No dependencies — can land independently, any time.**

---

## Infrastructure tickets (database + devops + ui-ux)

Resolves the previously-open question against `docs/ui-vision.md` §2:
"Infrastructure Health: Real-time monitoring metrics for internal server
health and database status." **Checked carefully, not assumed:** UI-07
only extends `admin-stats.component.tsx` (historical app-usage/activity
graphs — the vision's separate "Usage Graphs" bullet, already covered) and
`admin-errors.component.tsx` (application-level errors surfaced by
Postiz's own error tracking, not infra state). Neither touches server
process health, container status, or database connection/queue health.
**This is a genuine gap, not covered by anything already ticketed** —
it needs its own tickets, and pulls in devops (not otherwise part of this
backlog) since host/container health is that stream's domain.

### INFRA-01 — Infrastructure health metrics endpoint
New backend endpoint (Platform Admin only — this is inherently platform-
wide, not workspace-scoped, so it belongs behind `user.isSuperAdmin`, and
per CHARTER.md's "no published host ports" / segmented-network principle,
must not be reachable from the public API surface at all — internal only).
V1 scope, kept modest rather than building a full APM/Prometheus stack:
- **Database:** Postgres reachability + a query-latency ping, active
  connection count vs. pool max, whether all migrations are applied.
- **Queues:** Redis/BullMQ reachability, per-queue depth (waiting/active/
  failed), worker last-heartbeat.
- **Server:** per-container uptime (backend, frontend, orchestrator/
  worker), disk usage for the NVMe (`/srv/socialz-state`) and RAID/ZFS
  (`zpool_media/socialz`) mounts from CHARTER.md's infra section.
**Interpretation call, flagged rather than silently decided:** "real-time"
is implemented here as short-interval polling (e.g. every 10–30s) from the
frontend, not a websocket/SSE push mechanism — simpler, and sufficient for
an admin dashboard. If genuine push/streaming is actually wanted, that's a
materially bigger ticket and should be called out explicitly, not assumed.
**Owned by:** devops (metrics collection is host/container-level) with
database (the DB/queue queries) — coordinate, don't duplicate.

### UI-10 — Infrastructure health dashboard tab
New tab inside the UI-03 Platform Admin console (not per-workspace — see
ADR-0001's scoping rule) rendering INFRA-01's metrics, polling on the same
interval. Simple status tiles (green/amber/red) plus the raw numbers, not
a full charting library for V1.
**Depends on:** INFRA-01, UI-03.

---

### OPS-PRICING-COPY — Billing screens still advertise Postiz's pricing terms
UI-09 removed Postiz's brand name, logo, and false user-count/testimonial
claims from the billing screens, but the trial/pricing terms shown there
(`apps/frontend/src/components/new-layout/billing.after.tsx` and
`apps/frontend/src/components/billing/first.billing.component.tsx`) are
still Postiz's own commercial terms, e.g. "100% No-Risk Free Trial", "Pay
NOTHING for the first 7-days", "Cancel anytime, from settings". These are
plausible-sounding but unverified for Socialz — the owner must confirm
Socialz's actual trial length, refund/cancellation policy, and pricing
before these screens are shown to real clients.
**No dependencies — but blocks enabling billing for external clients.**

---

## Unassigned ops tickets (found during PR #5 review, 2026-09-16)

No stream owner assigned yet — flagged for the PM to route. One paragraph
each, not fully specced.

### OPS-EMAIL — Configure outbound email
Backend logs show "Email sender information not found" — outbound email
(invite links, notifications) isn't configured. CHARTER.md §5 already
scopes the domain piece (`suportsocialz@mpsolara.com`, Cloudflare Email
Routing handles inbound only) but a transactional outbound provider
(SPF/DKIM/DMARC on `mpsolara.com`) was left as a to-decide. Owner needs to
choose a provider before this can be configured; blocks anything relying
on email, invite-by-email (RBAC-08's existing flow) included.

### OPS-BACKUP — Automated nightly Postgres backups, stored off-NVMe, with a restore test
Set up automated nightly `pg_dump` backups of the main Postgres (and
`temporal-postgresql`) stored off the NVMe (`/srv/socialz-state`) itself —
a backup living on the same disk as the data it protects doesn't survive
that disk failing. Include a periodic *restore* test, not just confirming
the dump file exists, so a backup that silently can't be restored isn't
discovered during an actual incident. Also a direct prerequisite of
ADR-0004/DEVOPS-01's baseline runbook, which assumes a `pg_dump` backup
step exists — nothing currently automates it.

Built in the `devops/ops-backup` PR (`ops/`): nightly `pg_dump` of the
main Postgres with 7 daily + 4 weekly retention, a monthly restore test
into a throwaway container, and systemd timers. `temporal-postgresql` was
investigated and deliberately excluded from scope — see "Why
temporal-postgresql is excluded" in `ops/README.md` for the code-level
reasoning (scheduled posts already rebuild from the `Post` table via the
existing `missingPostWorkflow` reconciliation sweep, independent of
Temporal's own database).

### OPS-BACKUP-OFFSITE — Encrypted offsite copy of the nightly backups
`OPS-BACKUP`'s nightly backups (`ops/backup-postgres.sh`) live only on
`zpool_media/socialz-backups` — a different ZFS dataset from the NVMe the
live data is on, but still physically the same host. That protects
against a single-disk failure, not against the box itself being lost
(fire, theft, host-level failure/ransomware, RAID controller failure
taking multiple disks at once). Needs: an offsite destination, encryption
in transit and at rest (the dump is a full logical export — same secrets-
exposure concern already noted for `chmod 700` on the local copy, but now
leaving the host), and a decision on provider/target before this can be
scoped properly. Not built as part of `OPS-BACKUP` — deliberately deferred
to its own ticket rather than scope-creeping the nightly-backup PR.

### OPS-TEMPORAL-RECOVERY — App must recover if Temporal isn't ready after a host reboot
PR #7's Temporal healthcheck fix (`777a171e`) closes the boot race during
`docker compose up` (app now waits on `condition: service_healthy`), but
`depends_on` ordering only applies when Compose itself orchestrates
startup. On a host reboot, Docker's `restart: unless-stopped` policy
restarts each container independently — not via `compose up` — so that
ordering guarantee doesn't apply. Confirmed: no retry/reconnect logic
exists in the Temporal client code today
(`libraries/nestjs-libraries/src/temporal/`). If Temporal takes longer
than the app to become ready after a reboot, the app can come up
disconnected with no path back to working short of a manual `docker
compose restart` — it needs its own Temporal connection to retry with
backoff instead of failing once and staying dead.

### OPS-SECRETS — Move `temporal-postgresql`'s plaintext password to a secrets file
`temporal-postgresql` (`POSTGRES_PASSWORD: temporal`) and the `temporal`
service's `POSTGRES_PWD=temporal` env var currently hardcode the literal
password `temporal` directly in `docker-compose.yaml` — readable by
anything that can read the compose file or the process environment. The
main app's own Postgres, one service away in the same file, already uses
the correct pattern (`POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password`)
— replicate that existing pattern for `temporal-postgresql`/`temporal`
rather than inventing a new one.

---

## V2 — logged as a defined future phase, not ticketed yet

Per the project owner: do not scope this yet, but keep it visible so it
isn't lost.

- Dynamic token/coupon system. Full design now captured in `docs/CHARTER.md`
  §7 (opaque server-side token records, not self-encoded; SUPERADMIN/Platform
  Admin-only issuance; nullable bound-email for single-recipient vs. global
  tokens; required expiry; single-use redemption; generic failure message on
  redemption to avoid probing) — treat that section as the source of truth,
  not this summary line.
- Financial/subscription dashboard.
- System-wide broadcasts.
- Feature flags.
- API/rate-limit management.

**Before this is ever scoped:** check the existing `FEE_AMOUNT`/`STRIPE_*`
env vars and the CASL billing-tier layer in `permissions.service.ts` (see
ADR-0001) — extend that existing subscription-tier gating, don't build a
second, parallel one.

## Source: the owner's original UI vision

This entire V1/V2 split traces back to a UI vision the project owner gave
directly (relayed across several messages, never saved as its own document
until this pass) — now captured verbatim at `docs/ui-vision.md`. Its
"Disposition" section is the authoritative map from that vision's six
feature areas onto V1 (this backlog) and V2 (logged, not ticketed). One
item from it — Infrastructure Health monitoring — was still unresolved as
of the previous pass; see the new Infrastructure tickets below for its
resolution.
