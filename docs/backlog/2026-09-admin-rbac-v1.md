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
| 1 | `super.admin.guard.ts` (`SuperAdminGuard`, checks `hasSuperAdminUser(org.id)`) | Guard class used on the public API | **See flag below — not a mechanical rename.** |
| 2 | `public.integrations.controller.ts:385` (`GET /public-api/v1/integrations/users`) | Public-API impersonation-search endpoint, gated by `SuperAdminGuard` | Same flag as #1 |
| 3 | `public.auth.middleware.ts:40` | Synthesizes `req.org` for OAuth-token public-API callers, hardcodes `role: 'SUPERADMIN'` | `role: 'OWNER'` — represents full authority over the caller's own org, not platform-wide anything |
| 4 | `public.auth.middleware.ts:58` | Same, for API-key public-API callers | `role: 'OWNER'` |
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
| 19 | `teams.component.tsx:115,122` | Team-management "can I act on this member" level comparison, currently a 3-level scale (`USER`<`ADMIN`<`SUPERADMIN`) | Needs a real 6-level hierarchy, not a rename — this is UI-02's scope already; flag the coupling here so it isn't built twice |

**Flag on #1/#2 — resolve explicitly, don't silently carry forward:**
`PublicAuthMiddleware` (#3/#4) synthesizes a fake org context with
`role: 'SUPERADMIN'` for **every** authenticated public-API caller,
regardless of who they are. Since `SuperAdminGuard` (#1) just checks
"does this org have a `SUPERADMIN`," and the middleware fakes that role
unconditionally, **`SuperAdminGuard` currently always passes for any
valid public-API key/OAuth token** on this route — it is not actually
restricting the impersonation-search endpoint (#2) to real platform
admins today. This is a pre-existing gap, not something introduced by
this migration, but the migration forces a decision: mechanically
repointing `hasSuperAdminUser` to check `OWNER` instead just preserves
the same always-passes behavior (the middleware would fake `OWNER`
instead). Fixing it for real means checking `user.isSuperAdmin` against
the actual authenticated actor, which the public-API auth path doesn't
currently establish. **This needs an explicit decision — is
`GET /public-api/v1/integrations/users` supposed to be reachable by any
org's API key holder, or only a true Platform Admin — before this ticket
can close it out.**
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

## Also raised, not folded into this pass

The project owner was asked whether there's a separate UI idea to fold in
now; none was raised in this session's consolidated decision. Re-ask on the
next architect pass rather than assuming the answer is permanently no —
recorded as open in `docs/STREAM_TRACKER.md`.
