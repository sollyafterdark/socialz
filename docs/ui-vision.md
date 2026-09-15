# Admin Panel — Owner's Original UI Vision

Given directly by the project owner (2026-09-15). This is the source
document behind the V1/V2 split in docs/backlog/2026-09-admin-rbac-v1.md
— referenced but never previously saved as its own file, which is why an
earlier Architect pass couldn't locate it. Preserved verbatim below.

## Overview

I am building a comprehensive admin panel for a custom-built version of
the Postiz app. The interface should be organized using a multi-tab
layout for easy navigation and include the following core capabilities:

### 1. Account & Workspace Management
- Ability to view, restrict, suspend, or permanently delete user accounts
  and workspaces.

### 2. Analytics & System Health Monitoring
- Usage Graphs: Visual dashboards displaying historical user activity and
  platform usage.
- Infrastructure Health: Real-time monitoring metrics for internal server
  health and database status.

### 3. Dynamic Token & Coupon System
- Core Architecture: The backend must be designed so that tokens are
  deeply integrated into the system logic (i.e., the tokens directly
  trigger permission changes or billing updates, rather than just being
  text strings).
- Generation & Toggles: An admin interface with switches/toggles to
  generate custom tokens.
- Capabilities: Tokens should be able to trigger specific actions:
  - Grant 1-week, 2-week, or 1-month of free access.
  - Extend an existing user's free access.
  - Apply percentage or fixed-amount discounts to subscriptions.
  - Unlock partial access to specific premium platform features.
  - So when a token is entered, the system knows what it means and who
    it's for, all inside the number; it can be used again by anyone else.
  - Also allow global tokens.
- Redemption: Users must be able to redeem these tokens/coupons either
  directly on the login/signup screen or later within their user profile
  settings.

### Additional recommended features for the App Owner

1. **User Impersonation ("Login As")** — see exactly what a user sees to
   debug their issue, without needing their password.
2. **Financial & Subscription Dashboard** — MRR, failed payments,
   refunds, typically connected to Stripe.
3. **System-Wide Announcements (Broadcasts)** — push global banner
   notifications to all logged-in users (downtime, releases, bug fixes).
4. **Feature Flags / Toggles** — turn features on/off globally without a
   redeploy.
5. **API & Rate Limit Management** — monitor API usage per workspace and
   enforce rate limits, since a single spamming user can get the whole
   app banned by Meta.
6. **Audit Logs** — read-only log of every major admin action, so misuse
   or accidental deletion can be traced to who did it and when.

## Disposition (decided across subsequent discussion, see CHARTER.md and
docs/backlog/2026-09-admin-rbac-v1.md for full detail)

- V1 (ticketed, this PR): Account & Workspace Management, Audit Logs,
  extending existing usage/error monitoring. Two-layer role model
  (workspace + Platform Admin) added on top per separate discussion.
- V2 (logged, not yet ticketed): Token/Coupon system, Financial dashboard,
  Broadcasts, Feature Flags, API/rate-limit management.
- Infrastructure Health (item 2's server/database monitoring) — status
  not yet resolved; Architect to confirm against this document whether
  it's covered, deferred, or a genuine gap.
