# Stream Task Tracker

| # | Stream | Task | Status | Notes |
|---|--------|------|--------|-------|
| 1 | DevOps | Hardware/storage discovery audit | Done | Found /opt/socials, informed storage plan |
| 2 | DevOps | Propose LV/ZFS/compose/tunnel plan | Built, PR #1 open | Tunnel confirmed Healthy end-to-end; awaiting owner+PM merge review |
| 3 | Architect | Gap-analysis discovery pass | Done | RBAC/i18n/admin/studio/auth gap map delivered; confirmed HEAD is v2.23.0-141-gb38c43fa |
| 4 | Bootstrap | CLAUDE.md / CHARTER.md / agent files | Done | Pushed to main (3b3ca7cd) |
| 5 | Owner | Describe UI idea | Done | Given directly to the PM across several messages, relayed to Architect as synthesized instructions, never saved standalone until now — captured verbatim at `docs/ui-vision.md`; its Disposition section is the source of this backlog's V1/V2 split |
| 6 | Owner | Pick design connector (Figma/Miro/Canva) | Open, low priority | |
| 7 | Owner | Install Claude Code plugins/skills | Done | Confirmed |
| 8 | Architect/Postiz-Core | Is full Temporal+Elasticsearch the right long-term footprint for a single-org self-hosted deploy, or a future customization target? | Open, non-blocking | Raised by DevOps while wiring the compose file; deploy proceeds with the full stack in the meantime |
| 9 | Architect | RBAC + admin dashboard requirements brainstorm | In review (PR #2) | Owner gave consolidated decision (two-layer role model, soft-delete+30d purge, audit log day-one); 3 ADRs + V1/V2 backlog written. Owner review found and fixed: a real zero-OWNER migration bug in DB-01, a pre-existing public-API access-control gap in the SuperAdminGuard repoint (RBAC-04), and a genuine V1 gap (Infrastructure Health monitoring, now INFRA-01/UI-10) against `docs/ui-vision.md`. Still pending owner+PM sign-off to merge |
| 10 | DevOps | Temporal has no healthcheck; app depends_on uses service_started not service_healthy, causing a boot race where the app can start before Temporal is actually ready, silently breaking all auth until a manual restart | Open | Discovered 2026-09-15: app was stuck for ~10h with a dead backend despite Temporal being healthy the whole time. Fix: add a real healthcheck to temporal (e.g. a gRPC/TCP probe) and switch app's depends_on to condition: service_healthy |
