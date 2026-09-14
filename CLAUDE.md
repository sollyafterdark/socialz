# socialz — project memory

This repo is a fork of [gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app) (AGPL-3.0), customized with five additions. Full rationale and phased roadmap: `docs/CHARTER.md`.

## Stack
Next.js (React) + NestJS + Prisma/PostgreSQL + Redis (BullMQ/Temporal). Docker Compose for local/prod. Deployed to a self-hosted Ubuntu (RAID) box behind Cloudflare at `socialz.mpsolara.com`.

## What we're adding on top of stock Postiz
1. RBAC beyond basic team invites (roles: Owner, Admin, Editor, Translator, Viewer)
2. A translator portal for EN/RU content
3. Full EN/RU i18n coverage of the UI
4. A custom admin dashboard for workspace/workstation management
5. An integrated creative studio (asset editing) in the compose flow

## Hard rules
- **No raw-credential auth flows.** Every social platform connection goes through that platform's own OAuth screen (Meta Business Login for Instagram/Facebook). Never build a form that asks a user to type their Instagram/Facebook password into our app.
- **No agent merges its own work.** Every change lands via PR, gets the automated Code Review pass, then a human (project owner) approval, before merging to `main`.
- **Database migrations are PR-only.** No agent applies a Prisma migration directly against a running database, local or prod.
- **Never touch `/opt/socials`.** A separate, unrelated project lives there — do not read, modify, stop, or reference anything under `/opt/socials`, any container/network prefixed `socials-`/`socials_`, or the LV `ubuntu--vg-socials--state`. Out of scope entirely.
- Keep an `upstream` git remote pointed at `gitroomhq/postiz-app` and pull security fixes periodically.

## Approval tiers
- **Needs project-owner + PM sign-off before merge:** auth/RBAC, database migrations, deploy config, secrets/env vars, Meta/Instagram OAuth handling.
- **Review-stream can approve independently:** UI copy, styling, i18n string additions, small bug fixes outside the categories above.

## Conventions
- Branch naming: `<agent-or-role>/<short-description>`, e.g. `auth-rbac/workspace-roles`
- Commit messages: conventional commits (`feat:`, `fix:`, `chore:`, etc.)
- All new UI strings go through the i18n layer — no hardcoded English strings in components once Phase 2 starts.
- `COMPOSE_PROJECT_NAME=socialz`; all containers/networks prefixed `socialz-`/`socialz_`.
