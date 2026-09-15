-- DB-01: migrate UserOrganization.role from {SUPERADMIN, ADMIN, USER}
-- to {OWNER, ADMIN, EDITOR, CONTRIBUTOR, TRANSLATOR, VIEWER}, per
-- docs/adr/0001-two-layer-role-model.md.
--
-- DO NOT APPLY THIS BY HAND against a running database. Per CLAUDE.md,
-- database migrations are PR-only and this one additionally needs
-- project-owner + PM sign-off (auth/RBAC change) before it is ever run.
-- See ./README.md in this folder for: the rollback plan, the downtime
-- assessment, and the baselining step this repo needs before this file
-- can be applied with `prisma migrate deploy` (this repo has used
-- `prisma db push` exclusively until now -- this is its first migration
-- file).
--
-- Mechanical mapping:
--   ADMIN      -> ADMIN
--   USER       -> EDITOR
--   SUPERADMIN -> OWNER
--
-- Fallback owner promotion, required so every workspace comes out of this
-- migration with at least one OWNER (ADR-0001 / DB-01 in
-- docs/backlog/2026-09-admin-rbac-v1.md):
--   Rule 1: workspace has a SUPERADMIN row       -> that row maps to OWNER
--                                                    (falls out of the
--                                                    mechanical mapping
--                                                    above; nothing extra
--                                                    to do here).
--   Rule 2: no SUPERADMIN, has an ADMIN          -> earliest-created ADMIN
--                                                    (by UserOrganization
--                                                    .createdAt) promoted
--                                                    to OWNER.
--   Rule 3: no SUPERADMIN, no ADMIN, has members -> earliest-created
--                                                    member (any role)
--                                                    promoted to OWNER.
--   Rule 4: zero members                         -> cannot be
--                                                    auto-resolved; not
--                                                    handled here, left
--                                                    for manual review
--                                                    (see the
--                                                    pre-migration report
--                                                    in ../../scripts/).
--
-- Every workspace hitting rule 2, 3, or 4 must be reviewed against the
-- pre-migration report's output BEFORE this migration is authorized to
-- run for real -- that report names exactly which user gets auto-promoted
-- and why, per workspace.

BEGIN;

-- Step 1: compute rule-2 / rule-3 fallback promotions from the CURRENT
-- (pre-migration) role values, before the enum/column swap in Step 2
-- removes those values. Rule 1 needs no computation -- it falls out of
-- the mechanical SUPERADMIN -> OWNER mapping below. Rule 4 (zero members)
-- has no row to promote.
CREATE TEMP TABLE "_db01_fallback_promotions" ON COMMIT DROP AS
WITH orgs_with_superadmin AS (
  SELECT DISTINCT "organizationId"
  FROM "UserOrganization"
  WHERE role = 'SUPERADMIN'
),
orgs_with_admin AS (
  SELECT DISTINCT "organizationId"
  FROM "UserOrganization"
  WHERE role = 'ADMIN'
),
rule2_ranked AS (
  SELECT id, "organizationId",
         row_number() OVER (
           PARTITION BY "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS rn
  FROM "UserOrganization"
  WHERE role = 'ADMIN'
    AND "organizationId" NOT IN (SELECT "organizationId" FROM orgs_with_superadmin)
),
rule3_ranked AS (
  SELECT id, "organizationId",
         row_number() OVER (
           PARTITION BY "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS rn
  FROM "UserOrganization"
  WHERE "organizationId" NOT IN (SELECT "organizationId" FROM orgs_with_superadmin)
    AND "organizationId" NOT IN (SELECT "organizationId" FROM orgs_with_admin)
)
SELECT id, 2 AS fallback_rule FROM rule2_ranked WHERE rn = 1
UNION ALL
SELECT id, 3 AS fallback_rule FROM rule3_ranked WHERE rn = 1;

-- Step 2: swap the enum type and remap existing values mechanically.
-- NOTE: ALTER COLUMN ... TYPE ... USING forces a full rewrite of
-- UserOrganization under an ACCESS EXCLUSIVE lock -- see ./README.md's
-- downtime assessment before scheduling this.
ALTER TYPE "Role" RENAME TO "Role_old";

CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'CONTRIBUTOR', 'TRANSLATOR', 'VIEWER');

ALTER TABLE "UserOrganization"
  ALTER COLUMN role DROP DEFAULT;

-- The CASE has no ELSE: any pre-migration role value outside
-- {SUPERADMIN, ADMIN, USER} is a state this migration doesn't know how to
-- map, and casting NULL into a NOT NULL column will abort the transaction
-- rather than silently write a wrong role.
ALTER TABLE "UserOrganization"
  ALTER COLUMN role TYPE "Role" USING (
    CASE role::text
      WHEN 'SUPERADMIN' THEN 'OWNER'
      WHEN 'ADMIN'      THEN 'ADMIN'
      WHEN 'USER'       THEN 'EDITOR'
    END
  )::"Role";

ALTER TABLE "UserOrganization"
  ALTER COLUMN role SET DEFAULT 'EDITOR'::"Role";

DROP TYPE "Role_old";

-- Step 3: apply the rule-2 / rule-3 fallback promotions computed in Step 1.
-- (Rule 1 is already OWNER from the mechanical mapping in Step 2. Rule 4
-- workspaces have no row here and stay ownerless, flagged in the report
-- for manual resolution.)
UPDATE "UserOrganization"
SET role = 'OWNER'
WHERE id IN (
  SELECT id FROM "_db01_fallback_promotions" WHERE fallback_rule IN (2, 3)
);

COMMIT;
