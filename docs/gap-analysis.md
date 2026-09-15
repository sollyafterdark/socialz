# Postiz Gap Analysis (base commit b38c43fa, v2.23.0-141-gb38c43fa)

## RBAC
Exists: enum Role { SUPERADMIN, ADMIN, USER } and UserOrganization (user<->org<->role) in prisma/schema.prisma:944. CASL-based guard pipeline (apps/backend/.../permissions/permissions.{service,ability,guard}.ts) across 24 controllers. Invite flow in organization.service.ts. Superadmin-only impersonation in users.controller.ts.
Partial: CASL layer is almost entirely a billing/subscription-tier gate, not content permissions. Invite UI only offers USER/ADMIN.
Missing: No Owner/Editor/Translator/Viewer roles. No protected "Owner" concept. No per-resource permission checks. No translator-scoped access.

## i18n
Exists: Full i18next/react-i18next stack (libraries/react-shared-libraries/src/translation/*), 14 locales incl. complete Russian, lingo.dev auto-sync (i18n.json), 133 files / 210 call sites of useT/TranslatedLabel.
Partial: Some hardcoded strings remain (e.g. admin-stats.component.tsx date presets). Flat 14-language list, no EN/RU-only scoping.
Missing: No translator-facing workflow (missing-key review, EN/RU diff, approve-MT-output UI).
Decision: adopt as-is; only the translator portal UI is new scope.

## Admin Dashboard
Exists: admin/stats + admin/errors screens, admin.controller.ts (/errors, /errors/platforms, /stats). Impersonation as ad hoc "view as workspace."
Missing: No org/workspace list-and-manage view, no user-management screen, no remove-account/content capability, no assign-workspace-admin/co-owner UI, no cross-org billing console, no audit log.

## Creative Studio
Exists: Polotno canvas editor fully wired into compose flow (launches/polonto.tsx, media.component.tsx), AI image generation as a Polotno panel (billing-tier gated).
Missing: Video editing (preview only), no brand-kit/templates, no asset versioning.
Decision: adopt as-is; open question whether to strip the billing-tier gate on AI generation.

## Meta/Instagram Auth
Exists, clean: facebook.provider.ts (OAuth), instagram.provider.ts (Business-via-Facebook), instagram.standalone.provider.ts (Instagram consumer OAuth). No password fields.
Flag: tokens stored as plain String columns, no encryption at rest. Two distinct Instagram OAuth surfaces — need a decision on which socialz exposes. Other providers (Bluesky, Mastodon, Lemmy, Skool, Listmonk) do use username/password forms — that's those platforms' own convention, not a hard-rule violation.

## Monorepo
pnpm workspaces (not Nx, despite stale README text). apps/frontend (Next.js, i18n consumption, admin, studio), apps/backend (NestJS, RBAC guards, admin API, OAuth), libraries/nestjs-libraries (Prisma schema, provider integrations), libraries/react-shared-libraries (i18n infra). @gitroom/* are TS path aliases, not published packages.
