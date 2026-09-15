# ADR-0001: Two-layer RBAC — workspace roles + global Platform Admin

**Status:** Accepted
**Date:** 2026-09-15
**Owners:** auth-rbac (implementation), database (schema), architect (this record)

## Context

CLAUDE.md's target role list is Owner, Admin, Editor, Translator, Viewer. The
project owner's concrete ask adds a sixth: Contributor/Draft (write access,
requires approval to publish), plus a global "co-owner"-adjacent concept for
platform-wide management ("Platform Admin").

The existing schema already has two unrelated things both informally called
"super admin," and conflating them was the biggest risk in this design:

1. `UserOrganization.role: Role` (`SUPERADMIN | ADMIN | USER`) — scoped to a
   single `UserOrganization` row, i.e. one workspace. Used narrowly: org-switcher
   display label, `SuperAdminGuard` (org-scoped impersonation gate), and the
   impersonation check in `users.controller.ts`.
2. `User.isSuperAdmin: Boolean` — a genuinely global flag on the `User` row
   itself, already gating 20+ endpoints across billing, admin stats/errors,
   announcements, and posts debug tooling (`billing.controller.ts`,
   `admin.controller.ts`, `announcements.controller.ts`, `users.controller.ts`,
   `auth.middleware.ts`, both `admin-*.component.tsx` frontend guards).

Only #2 is actually cross-workspace today. #1 is an org-scoped role that
happens to share a name with #2, which is exactly the collision the project
owner flagged: "Owner and SUPERADMIN are never the same role" and "never call
the platform layer 'Org' anything."

## Decision

**Workspace layer** — `Role` enum on `UserOrganization` becomes:

```
OWNER, ADMIN, EDITOR, CONTRIBUTOR, TRANSLATOR, VIEWER
```

- `OWNER` is multi-holder: any number of users in a workspace may hold it
  simultaneously. Any existing `OWNER` may promote another member to `OWNER`
  or demote an `OWNER` back to `ADMIN`. The application layer (not a DB
  constraint — Postgres can't easily express "at least one row of this org
  has this role") must reject any promote/demote/remove operation that would
  leave a workspace with zero `OWNER`s.
- `EDITOR` replaces the current `USER` role 1:1 in capability (create, edit,
  publish directly) — it is not a downgrade.
- `CONTRIBUTOR` is new: can create/edit content but cannot transition it to a
  publishable state directly. See "Contributor approval" below.
- `TRANSLATOR` is required per CLAUDE.md and must not be dropped from this
  list even though its scoped permissions are a separate, smaller ticket.
- The workspace `Role` enum **retires `SUPERADMIN` entirely.** It is not
  renamed, not aliased — removed. This is what makes "Owner and SUPERADMIN
  are never the same role" true by construction: SUPERADMIN stops being a
  workspace-scoped concept at all.

**Platform layer** — reuses `User.isSuperAdmin` as-is, renamed only in UI
copy/branding to "Platform Admin." No new column: this flag is already
global, already multi-holder (any number of `User` rows can have it true),
and already wired into the endpoints that matter. Promote/demote endpoints
enforce the same "never remove the last one" invariant as `OWNER`, scoped
globally instead of per-workspace. The project owner is the initial holder.

**Data migration** (owner+PM sign-off required, per CLAUDE.md's approval
tiers — this is an auth/RBAC schema change):
- `UserOrganization.role = ADMIN` → stays `ADMIN`.
- `UserOrganization.role = USER` → becomes `EDITOR` (preserves current
  capability; nothing regresses for existing users on migration day).
- `UserOrganization.role = SUPERADMIN` → becomes `OWNER` in that workspace.
  Before running this, the database ticket must produce a report of which
  users this affects, so the project owner can separately decide — by hand,
  it's a judgment call, not a mechanical one — whether any of them should
  *also* get `User.isSuperAdmin = true` (Platform Admin). The migration does
  not do this automatically.

**`SuperAdminGuard`** (`apps/backend/src/services/auth/super.admin.guard.ts`)
currently checks the org-scoped role, which no longer exists after this
migration. Its ~handful of call sites must be audited and repointed to
either `User.isSuperAdmin` (if the check was actually meant to be
platform-wide) or dropped/replaced by an `OWNER` check (if it was meant to
be workspace-wide). This is an auth-rbac ticket, not automatic.

**Contributor approval** is a new, narrow mechanism — explicitly *not* a
reuse of `Post.submittedForOrderId` / `Post.approvedSubmitForOrder`. Those
fields belong to the existing Orders marketplace feature (submitting content
*to a different organization*, tied to billing). Reusing them for intra-
workspace Contributor-to-Editor approval would let an unrelated cross-org
billing feature leak into ordinary content moderation. The exact new
field(s) are a database-ticket design decision; the constraint this ADR
fixes is that they must be additive and separate from the Orders fields.

**CASL note:** the existing `permissions.service.ts` / `Sections` enum is a
billing/subscription-tier gate (channel limits, posts/month, team size), not
a content-permission system — confirmed by inspection, matching the prior
gap-analysis pass. This role model is not layered on top of CASL; it's a
parallel, role-based check. Do not try to force role checks through
`Sections`/`AuthorizationActions` — extend a separate guard/decorator
instead.

## Consequences

- One clean mental model: "workspace role" answers *what can I do in this
  workspace*, "Platform Admin" answers *do I see every workspace*. No role
  name is overloaded across both.
- The migration is a real cutover with a real data mapping — it needs a
  down-migration or at minimum a verified backup before it runs against any
  populated database, and it is squarely in the "database migrations are
  PR-only, needs owner+PM sign-off" tier.
- `SuperAdminGuard`'s current behavior (org-scoped) quietly disappears when
  the enum value it depends on is removed; every call site must be checked
  by hand, not assumed safe.
