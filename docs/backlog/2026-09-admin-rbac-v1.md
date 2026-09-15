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
`SUPERADMIN`→`OWNER`. Migration script must first output a report (which
rows are currently `SUPERADMIN`, which org, which user/email) for the
project owner to review before/alongside the cutover, since some of those
users may also need `User.isSuperAdmin = true` set by hand (a judgment
call ADR-0001 explicitly does not automate). Include a rollback plan.
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

### RBAC-04 — Platform Admin: promote/demote + repoint `SuperAdminGuard`
Implements ADR-0001's platform layer. Promote/demote endpoints on
`User.isSuperAdmin` with the same last-remaining-holder invariant as
RBAC-01, scoped globally. Also: audit every current call site of
`SuperAdminGuard` (org-scoped today) and repoint each to either
`User.isSuperAdmin` or an `OWNER` check, per what that call site actually
needs — this guard's behavior silently breaks once DB-01 removes the
`SUPERADMIN` enum value it depends on, so this must land in the same
release as DB-01, not after.
**Depends on:** DB-01, DB-04.

### RBAC-05 — Account removal (suspend + soft-delete)
Two scopes sharing one implementation: workspace Owner/Admin can
suspend/remove members of their own workspace; Platform Admin can do the
same for any account in any workspace. Calls DB-03's soft-delete path.
Audit-logged.
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
