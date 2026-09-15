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
- A recurring purge job (BullMQ, daily) processes any row where `deletedAt`
  is older than 30 days. Purge eligibility is computed at job run time as
  `deletedAt + 30 days` — no separate "purge-at" column, since that value is
  fully derivable and a second column would just be a second place for the
  two to drift out of sync.
- **What "purge" does differs by model, and this is a deliberate asymmetry,
  not an inconsistency:**
  - `Post`: purge means hard delete. Nothing else is designed to hold a
    surviving reference to a purged post's id.
  - `User`: purge means **anonymize, not hard delete.** Per DB-03's
    soft-transfer design, `Post.authorId` (and any future FK into `User`)
    keeps pointing at the same user row indefinitely, including after that
    user's account is removed from a workspace — that's the whole point of
    "Former Member" attribution surviving removal. If the purge job hard-
    deleted the `User` row 30 days later, every one of those references
    would break (or cascade-delete content that was never itself removed)
    silently, on a delay — the exact failure mode a reviewer would only
    catch by testing 30 days out. Instead, the purge job replaces
    name/email/avatar/other PII with a placeholder and flags the row as
    purged, but keeps the row (and its id) alive. UI reads this flag to
    render "Deactivated User" instead of "Jane Doe (Former Member)" — see
    DB-03.
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
  the database ticket should build one reusable "soft-delete + purge" helper,
  parameterized by outcome (hard-delete vs. anonymize) rather than
  duplicating the query/job scheduling logic per model.
- Cascading removals — what happens to content authored by a removed
  account — is resolved by DB-03 as "soft transfer": content stays tied to
  the workspace, `Post.authorId` keeps pointing at the (possibly later
  anonymized) `User` row, and a workspace admin can reassign it to an active
  member. This ADR's anonymize-not-delete rule for `User` purge exists
  specifically to make that resolution durable past the 30-day mark.
- Audit logging (ADR-0003) must record both the soft-delete and the eventual
  purge, since the purge is the point past which recovery becomes
  impossible — that's worth a durable record even after the row is gone.
