# Socialz Project Charter & Architecture Blueprint
**Domain:** socialz.mpsolara.com · **Repo role:** Single Source of Truth (SSOT) · **Owner/PM sign-off required on every merge to `main`**

---

## 0. Executive Decision: Fork, Don't Rebuild

Postiz (gitroomhq/postiz-app, AGPL-3.0) already provides multi-platform scheduling, official OAuth-based Meta connectivity, team/workspace collaboration, and a Next.js + NestJS + Prisma/PostgreSQL + Redis stack. We fork and customize rather than rebuild. Five custom additions: RBAC beyond basic team invites, a translator portal, full EN/RU i18n, a custom admin dashboard, an integrated creative studio.

**License note:** AGPL-3.0's copyleft trigger is network use. Internal/single-org use is a non-issue; reselling as SaaS to third parties needs a legal look first.

---

## 1. Architecture & Phased Workflow

Layered on top of Postiz: presentation (Next.js, i18n, admin/studio modules) → API (NestJS, RBAC guards) → domain (Postiz core + our modules) → data (Postgres/Redis/Temporal) → infra (Docker Compose on the RAID box, behind Cloudflare).

Phases: 0 Foundation → 1 Identity & RBAC → 2 Localization → 3 Admin Dashboard → 4 Creative Studio → 5 Hardening & CI/CD.

---

## 2. AI Agent Team

Architect/Backlog, Postiz-Core/Integrations, Database, Auth/RBAC, i18n & Translator Portal, UI/UX, DevOps/Linux Deployer, plus an independent Review/Security pass via the `code-review` and `security-guidance` plugins. No agent merges its own work.

---

## 3. Infrastructure

- **NVMe** (`/srv/socialz-state`): Postgres data, Redis data, logs, backups.
- **RAID / ZFS** (`zpool_media/socialz`): uploaded media only, via Postiz's `STORAGE_PROVIDER=local` + `UPLOAD_DIRECTORY`.
- **Docker**: `COMPOSE_PROJECT_NAME=socialz`, containers/networks prefixed `socialz-`/`socialz_`, segmented networks (app/data internal-only, edge/egress for gateway+tunnel), no published host ports.
- **Cloudflare**: dedicated tunnel + token for `socialz.mpsolara.com`, separate from any other project's tunnel.
- **Isolation**: `/opt/socials` and everything prefixed `socials-`/`socials_` is a separate, unrelated project — never touched by this repo's tooling.

---

## 4. CI/CD

GitHub-hosted runner for PR-time lint/build (`.github/workflows/build.yml`
runs `pnpm install`/`pnpm run build` on push/PR/merge_group).

**No automated deploy-on-merge exists.** Corrected 2026-09-16 — this
section previously described a self-hosted runner on soltech doing
pull → build → up -d → migrate → health check → rollback, which did not
reflect reality. Actual process: deploys are manual, from
`/home/steve/socialz` — the dedicated, deploy-only checkout pinned to
`main` (no other stream works from that path; see DEVOPS-02 in
`docs/backlog/2026-09-admin-rbac-v1.md`) — run by a human after a
reviewed PR merge, with a `pg_dump` backup taken first, then pulling and
bringing the stack up by hand. Automating this is future scope, not
current process.

---

## 5. Email

`support-socialz@mpsolara.com` — Cloudflare Email Routing handles inbound forwarding only. Outbound "send as" requires a transactional provider (SPF/DKIM/DMARC on `mpsolara.com`) configured separately.

---

## 6. Brand & Legal

Decided by the project owner, 2026-09-15/16:
- **Brand name:** Socialz.
- **Legal entity name:** MP Solara.
- **Public registration:** stays open (not invite-only).

## 7. V2 Scope: Token & Coupon System (deferred, not yet ticketed)

Secure, targeted promotional/administrative tokens. Not built in V1 — this section exists so the design isn't lost before V2 starts.

**Who can issue:** SUPERADMIN (Platform Admin) only. Never a workspace-level Owner or Admin — this grants free access or discounts against the platform operator's own revenue, so it belongs exclusively at the platform layer.

**Architecture:** Opaque random token string + server-side database record — not a self-encoded/decodable token. The string carries no meaning of its own; all real data (bound email, workspace, perk type/amount, expiry, redemption state) lives in the record it looks up. This allows revocation and edits after issuing, and avoids the forgery risk of a self-encoded format.

**Fields per token:**
- Bound email — nullable. Set = single named recipient only; redemption is rejected if the redeemer's account doesn't match. Null = a global token, redeemable by anyone.
- Target workspace (if applicable to the perk).
- Perk type: subscription extension (1 week / 2 weeks / 1 month), free access to specific platforms, percentage or fixed-amount discount.
- Expiry date — required on every token, no indefinitely-valid tokens.
- Redemption state (`redeemed_at` / `redeemed_by`) — enforces single-use.

**Redemption:** at signup or from the logged-in user's profile settings. On failure (wrong email, expired, already redeemed, doesn't exist), show one generic "this code isn't valid" message in all cases — never a distinct reason, to avoid letting someone probing codes learn which are real or who they belong to.

**Audit logging:** token generation and redemption are both logged events, per the V1 audit-log requirement — this is an extension of that system when V2 starts, not a separate logging mechanism.
