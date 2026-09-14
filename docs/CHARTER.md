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

GitHub-hosted runner for PR-time lint/build/automated review. Self-hosted runner on soltech for deploy-on-merge: pull → build → up -d → migrate → health check → rollback on failure.

---

## 5. Email

`suportsocialz@mpsolara.com` — Cloudflare Email Routing handles inbound forwarding only. Outbound "send as" requires a transactional provider (SPF/DKIM/DMARC on `mpsolara.com`) configured separately.
