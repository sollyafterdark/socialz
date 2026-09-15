-- DB-01 pre-migration report (docs/adr/0001-two-layer-role-model.md,
-- docs/backlog/2026-09-admin-rbac-v1.md).
--
-- READ-ONLY. Safe to run at any time, including repeatedly, against a
-- live database -- it contains no writes. This is the report the project
-- owner needs to review, per workspace, before ever authorizing the
-- actual DB-01 migration (../migrations/20260915120000_migrate_role_enum_to_six_roles)
-- to run.
--
-- How to run it:
--   docker exec -i socialz-postgres psql -U postiz-user -d postiz-db \
--     < libraries/nestjs-libraries/src/database/prisma/scripts/db-01-pre-migration-report.sql
--
-- or, from anywhere with DATABASE_URL set to the target database:
--   psql "$DATABASE_URL" -f libraries/nestjs-libraries/src/database/prisma/scripts/db-01-pre-migration-report.sql
--
-- Query 1 below classifies every workspace by which of ADR-0001's four
-- fallback rules would fire, and for rules 2-4 names exactly which user
-- would be auto-promoted to OWNER and why. Ordered so the non-obvious
-- cases (rules 2-4) surface first -- rule 1 (mechanical SUPERADMIN ->
-- OWNER, nothing to review) sorts last.
--
-- Rules 2/3 match migration.sql's actual selection exactly: among
-- candidates, a non-disabled / non-soft-deleted / activated ("healthy")
-- row is preferred over an unhealthy one, tie-broken by earliest
-- UserOrganization.createdAt; only if no healthy candidate exists in that
-- workspace does an unhealthy one get promoted. `auto_promoted_is_healthy`
-- below flags exactly that case, since a disabled/deactivated OWNER
-- satisfies the "workspace has an OWNER" invariant on paper but can't
-- actually log in -- worth the owner's attention even though it's not a
-- different rule.
--
-- Query 2 lists every row currently SUPERADMIN, so the owner can decide
-- by hand which of those users should *additionally* get
-- User.isSuperAdmin = true (Platform Admin). That decision is manual —
-- this report only surfaces the candidates, it does not recommend one.

\echo '=== DB-01 report: per-workspace OWNER fallback resolution ==='

WITH org_roles AS (
  SELECT
    uo.id,
    uo."organizationId",
    uo."userId",
    uo.role::text AS role,
    uo."createdAt",
    uo.disabled,
    u.email,
    u.name,
    (NOT uo.disabled AND u."deletedAt" IS NULL AND u.activated) AS is_healthy
  FROM "UserOrganization" uo
  JOIN "User" u ON u.id = uo."userId"
),
member_counts AS (
  SELECT
    o.id AS "organizationId",
    o.name AS "organizationName",
    count(r.id) AS member_count,
    count(r.id) FILTER (WHERE r.role = 'SUPERADMIN') AS superadmin_count,
    count(r.id) FILTER (WHERE r.role = 'ADMIN') AS admin_count
  FROM "Organization" o
  LEFT JOIN org_roles r ON r."organizationId" = o.id
  GROUP BY o.id, o.name
),
earliest_admin AS (
  SELECT DISTINCT ON ("organizationId")
    "organizationId", "userId", email, name, "createdAt", is_healthy
  FROM org_roles
  WHERE role = 'ADMIN'
  ORDER BY "organizationId", is_healthy DESC, "createdAt" ASC, id ASC
),
earliest_member AS (
  SELECT DISTINCT ON ("organizationId")
    "organizationId", "userId", email, name, "createdAt", is_healthy
  FROM org_roles
  ORDER BY "organizationId", is_healthy DESC, "createdAt" ASC, id ASC
)
SELECT
  mc."organizationId",
  mc."organizationName",
  mc.member_count,
  mc.superadmin_count,
  mc.admin_count,
  CASE
    WHEN mc.superadmin_count > 0 THEN 1
    WHEN mc.admin_count > 0 THEN 2
    WHEN mc.member_count > 0 THEN 3
    ELSE 4
  END AS fallback_rule,
  CASE
    WHEN mc.superadmin_count > 0 THEN NULL
    WHEN mc.admin_count > 0 THEN ea."userId"
    WHEN mc.member_count > 0 THEN em."userId"
  END AS auto_promoted_user_id,
  CASE
    WHEN mc.superadmin_count > 0 THEN NULL
    WHEN mc.admin_count > 0 THEN ea.email
    WHEN mc.member_count > 0 THEN em.email
  END AS auto_promoted_email,
  CASE
    WHEN mc.superadmin_count > 0 THEN NULL
    WHEN mc.admin_count > 0 THEN ea.name
    WHEN mc.member_count > 0 THEN em.name
  END AS auto_promoted_name,
  CASE
    WHEN mc.superadmin_count > 0 THEN NULL
    WHEN mc.admin_count > 0 THEN ea.is_healthy
    WHEN mc.member_count > 0 THEN em.is_healthy
  END AS auto_promoted_is_healthy,
  CASE
    WHEN mc.superadmin_count > 0 THEN
      'Rule 1: has SUPERADMIN row(s) -> map to OWNER mechanically, no auto-promotion decision needed'
    WHEN mc.admin_count > 0 AND ea.is_healthy THEN
      'Rule 2: no SUPERADMIN; earliest-created ADMIN (by UserOrganization.createdAt) auto-promoted to OWNER'
    WHEN mc.admin_count > 0 THEN
      'Rule 2: no SUPERADMIN; no healthy ADMIN candidate -- earliest-created ADMIN auto-promoted to OWNER despite being disabled/deactivated/deleted, review before cutover'
    WHEN mc.member_count > 0 AND em.is_healthy THEN
      'Rule 3: no SUPERADMIN or ADMIN; earliest-created member of any role auto-promoted to OWNER'
    WHEN mc.member_count > 0 THEN
      'Rule 3: no SUPERADMIN or ADMIN; no healthy member candidate -- earliest-created member auto-promoted to OWNER despite being disabled/deactivated/deleted, review before cutover'
    ELSE
      'Rule 4: zero members -- cannot auto-resolve, flag for manual review'
  END AS reason
FROM member_counts mc
LEFT JOIN earliest_admin ea ON ea."organizationId" = mc."organizationId"
LEFT JOIN earliest_member em ON em."organizationId" = mc."organizationId"
ORDER BY fallback_rule DESC, mc."organizationName";

\echo ''
\echo '=== DB-01 report: current SUPERADMIN rows (decide User.isSuperAdmin by hand) ==='

SELECT
  uo."organizationId",
  o.name AS "organizationName",
  uo."userId",
  u.email,
  u.name,
  uo."createdAt" AS became_superadmin_at,
  u."isSuperAdmin" AS already_platform_admin
FROM "UserOrganization" uo
JOIN "User" u ON u.id = uo."userId"
JOIN "Organization" o ON o.id = uo."organizationId"
WHERE uo.role = 'SUPERADMIN'
ORDER BY o.name, uo."createdAt";
