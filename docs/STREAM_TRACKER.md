# Stream Task Tracker

| # | Stream | Task | Status | Notes |
|---|--------|------|--------|-------|
| 1 | DevOps | Hardware/storage discovery audit | Done | Found /opt/socials, informed storage plan |
| 2 | DevOps | Propose LV/ZFS/compose/tunnel plan | Built, PR #1 open | Tunnel confirmed Healthy end-to-end; awaiting owner+PM merge review |
| 3 | Architect | Gap-analysis discovery pass | Done | RBAC/i18n/admin/studio/auth gap map delivered; confirmed HEAD is v2.23.0-141-gb38c43fa |
| 4 | Bootstrap | CLAUDE.md / CHARTER.md / agent files | Done | Pushed to main (3b3ca7cd) |
| 5 | Owner | Describe UI idea | Still open | Asked again during RBAC/admin brainstorm (task #9); none raised yet — re-ask next pass, don't assume "no" |
| 6 | Owner | Pick design connector (Figma/Miro/Canva) | Open, low priority | |
| 7 | Owner | Install Claude Code plugins/skills | Done | Confirmed |
| 8 | Architect/Postiz-Core | Is full Temporal+Elasticsearch the right long-term footprint for a single-org self-hosted deploy, or a future customization target? | Open, non-blocking | Raised by DevOps while wiring the compose file; deploy proceeds with the full stack in the meantime |
| 9 | Architect | RBAC + admin dashboard requirements brainstorm | Done | Owner gave consolidated decision (two-layer role model, soft-delete+30d purge, audit log day-one); 3 ADRs + V1/V2 backlog written, PR pending owner+PM sign-off |
