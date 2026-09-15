# ADR-0002: Soft delete with a 30-day retention window, for both accounts and content

**Status:** Accepted
**Date:** 2026-09-15
**Owners:** database (schema/purge job), auth-rbac (removal endpoints), ui-ux (restore affordance)

## Context

The project owner's decision: removal must be recoverable (accidental or
malicious removal shouldn't be permanent-forever) but storage must not grow
unbounded (permanent-forever retention isn't acceptable either). This applies
uniformly to both account removal and content removal — not two different
policies.

Scope note: "account" here means a workspace member (`User` /
`UserOrganization`), per the owner's clarification — not a connected social
platform account (`Integration`). `Integration.deletedAt` is a pre-existing,
unrelated mechanism and is untouched by this ADR.

## Decision

- Removing an account or a piece of content sets the existing `deletedAt`
  timestamp on the row (`User.deletedAt` and `Post.deletedAt` already exist
  in the schema — no new "is this deleted" column needed). The row is
  immediately hidden from all normal UI/API reads, stops functioning
  (account: can't log in / act in any workspace; content: stops
  publishing/scheduling), but is not removed from the database.
- A recurring purge job (BullMQ, daily) permanently deletes any row where
  `deletedAt` is older than 30 days. Purge eligibility is computed at job
  run time as `deletedAt + 30 days` — no separate "purge-at" column, since
  that value is fully derivable and a second column would just be a second
  place for the two to drift out of sync.
- Because it's recoverable-by-design, there must be a "restore" path (at
  minimum an API endpoint; a UI affordance is a ui-ux ticket) that clears
  `deletedAt` for anything still inside the 30-day window. Once purged,
  restore is impossible by construction — that's the point of the window.
- 30 days is the default per the owner's framing ("adjust if you have a
  reason to"); no reason surfaced during this pass to deviate from it. If a
  future need arises (e.g. compliance-driven shorter/longer retention), it
  should be a config value, not hardcoded per model, so it isn't a second
  migration to change it.

## Consequences

- Two purge jobs conceptually (accounts, content) but one shared pattern —
  the database ticket should build one reusable "soft-delete + purge" helper
  rather than duplicating the query/job logic per model.
- Cascading removals (e.g. removing an account: what happens to content they
  authored?) is a real open question this ADR does not resolve — it's a
  database-ticket-level design call, flagged explicitly there rather than
  guessed at here.
- Audit logging (ADR-0003) must record both the soft-delete and the eventual
  purge, since the purge is the point past which recovery becomes
  impossible — that's worth a durable record even after the row is gone.
