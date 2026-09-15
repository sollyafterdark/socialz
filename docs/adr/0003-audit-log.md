# ADR-0003: Audit log is built alongside V1 admin actions, not after

**Status:** Accepted
**Date:** 2026-09-15
**Owners:** database (schema), auth-rbac (write path)

## Context

The project owner was explicit: audit logging for every admin action
(suspend, delete, role change, and later token redemption) is part of the
V1 account-management and Platform Admin work itself, not a follow-up
ticket. Building admin capabilities first and bolting logging on afterward
risks shipping actions with no record of who did them.

## Decision

- New `AuditLog` model (exact field list is a database-ticket design task,
  not fixed by this ADR): actor (`userId`), scope (workspace-scoped action
  vs. platform-scoped action — must be distinguishable, since a Platform
  Admin action may not belong to any single workspace), action type, target
  type + id, a metadata payload, timestamp.
- Every V1 admin action gets exactly one audit row, written in the same
  service call that performs the action — not queued/best-effort. If the
  write fails, that's a bug to surface, not silently swallow, since a
  missing audit row for a destructive action defeats the purpose.
- "Every V1 admin action" concretely means: role change (including
  promote/demote Owner and Platform Admin), account suspend, account
  soft-delete, account restore, content soft-delete, content restore. The
  eventual purge (ADR-0002) also gets a row, since it's the point recovery
  becomes impossible.
- Each stream (auth-rbac, ui-ux where it triggers actions directly) is
  responsible for calling the shared audit-write helper at the point of
  action — this ADR does not mandate a specific interceptor/decorator
  mechanism; that implementation choice belongs to auth-rbac.

## Consequences

- Every V1 ticket that adds an admin action must also wire its audit-log
  call in the same PR — reviewers should treat a missing audit write as a
  blocking gap, not a follow-up.
- A read/view surface for the log (who can see it, workspace-scoped vs.
  platform-wide) is a ui-ux ticket, listed separately in the V1 backlog.
