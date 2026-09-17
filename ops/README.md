# Socialz Postgres backups

Nightly `pg_dump` of the main app database (`postiz-db`), written off the
NVMe the live data lives on, with a periodic restore test so a backup that
silently can't be restored is caught before an actual incident. See
`docs/backlog/2026-09-admin-rbac-v1.md` (OPS-BACKUP).

Scope: the main app Postgres (`socialz-postgres` / `postiz-db`) only.
`temporal-postgresql` is deliberately excluded — see "Why temporal-postgresql
is excluded" below.

## What's here

- `backup-postgres.sh` — nightly `pg_dump`, atomic (`.dump.partial` ->
  `.dump` only on success), 7 daily + 4 weekly retention.
- `restore-test.sh` — restores the newest backup into a throwaway,
  fully isolated `postgres:17-alpine` container and checks row counts.
- `socialz-backup.service` / `.timer` — runs the backup nightly at 03:00.
- `socialz-restore-test.service` / `.timer` — runs the restore test
  monthly, an hour after that night's backup.

## One-time owner setup (requires sudo)

Run from a clone of this repo on the host (e.g. `/home/steve/socialz`,
the deploy checkout).

1. Create the dedicated backup dataset, off the NVMe the live Postgres
   data lives on:
   ```
   sudo zfs create -o quota=50G zpool_media/socialz-backups
   sudo chmod 700 /zpool_media/socialz-backups
   ```
   The 700 permission matters: `pg_dump -Fc` output is a full logical
   dump of the database, including every secret stored in it.

2. Copy the scripts and systemd units into place:
   ```
   sudo mkdir -p /opt/socialz-ops
   sudo cp ops/backup-postgres.sh ops/restore-test.sh /opt/socialz-ops/
   sudo chmod 700 /opt/socialz-ops/backup-postgres.sh /opt/socialz-ops/restore-test.sh
   sudo cp ops/socialz-backup.service ops/socialz-backup.timer \
           ops/socialz-restore-test.service ops/socialz-restore-test.timer \
           /etc/systemd/system/
   ```

3. Reload systemd and enable both timers:
   ```
   sudo systemctl daemon-reload
   sudo systemctl enable --now socialz-backup.timer
   sudo systemctl enable --now socialz-restore-test.timer
   ```

4. Run one backup and one restore test by hand, don't wait for 03:00 to
   find out something's wrong:
   ```
   sudo systemctl start socialz-backup.service
   sudo systemctl status socialz-backup.service
   sudo systemctl start socialz-restore-test.service
   sudo systemctl status socialz-restore-test.service
   ```
   Both should exit 0 (`status` shows `active (exited)` / `Main PID ...
   (code=exited, status=0/SUCCESS)`), and `/zpool_media/socialz-backups`
   should now contain one `postiz-db_<timestamp>.dump` file.

## Checking on it later

```
journalctl -u socialz-backup --since "7 days ago"
journalctl -u socialz-restore-test --since "3 months ago"
systemctl list-timers socialz-backup.timer socialz-restore-test.timer
```

A failed run shows up as a non-zero exit in `journalctl -u socialz-backup`
(the script's own `ERROR:` line is the last thing logged before that) and
as `systemctl status socialz-backup.service` reporting `failed` rather
than `active (exited)`.

## Why temporal-postgresql is excluded

Investigated whether `temporal-postgresql` (Temporal's own internal
database — workflow execution history, not app data) needs to be in
scope too, since the original OPS-BACKUP note mentioned it.

Scheduled posts are governed by two things working together:
- The `Post` row in the **main** `postiz-db` — `publishDate`, `state`
  (`QUEUE` until published), and everything the post actually needs to
  publish. This is the source of truth for *what* to publish and *when*.
- A Temporal workflow (`postWorkflowV112`,
  `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts`)
  that `sleep()`s until `publishDate` (a durable timer, backed by
  Temporal's own event history in `temporal-postgresql`), then calls back
  into the main app via activities (`getPost`, `postSocialPending`,
  `updatePost`, ... — `apps/orchestrator/src/activities/post.activity.ts`)
  to actually publish and update the `Post` row.

If `temporal-postgresql`'s data were lost, every in-flight workflow
execution — including every post currently sitting in that `sleep()`,
which is the normal state for anything scheduled but not yet due — is
gone. None of those durable timers fire on their own.

But there's already a code-level self-healing mechanism that rebuilds
scheduling from the `Post` table, independent of Temporal's own state:
- `InfiniteWorkflowRegister.onModuleInit()`
  (`libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts`)
  unconditionally tries to start `missingPostWorkflow` with a fixed
  `workflowId` on **every app boot**, swallowing the "already exists"
  error that's the normal case — so if that workflow's history was wiped
  along with everything else, the very next app restart (or first boot
  after Temporal is back with an empty database) recreates it.
- `missingPostWorkflow`
  (`apps/orchestrator/src/workflows/missing.post.workflow.ts`) runs
  `searchForMissingThreeHoursPosts` immediately, then every hour forever.
- That activity
  (`apps/orchestrator/src/activities/post.activity.ts`, calling
  `PostsRepository.searchForMissingThreeHoursPosts` in
  `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`)
  queries `postiz-db` directly for every `Post` still in `state: 'QUEUE'`
  whose `publishDate` has already passed (within the last 2 days), and
  for each one calls `signalWithStart(..., workflowIdConflictPolicy:
  'USE_EXISTING')` — which starts a **fresh** workflow execution from the
  `Post` row's own data if none currently exists for that post.

Net effect: a scheduled post survives total loss of `temporal-postgresql`
and still gets published — rebuilt entirely from the `Post` table — with
a bounded worst-case delay of about an hour past its scheduled time (the
sweep interval), rather than firing exactly on time via Temporal's
durable timer. Posts overdue by more than 2 days at sweep time fall
outside that recovery window, but that staleness cliff is a pre-existing
property of `searchForMissingThreeHoursPosts` itself, not something
introduced by skipping `temporal-postgresql` backups.

**Recommendation: exclude `temporal-postgresql` from this backup.** The
thing that actually matters for scheduled posts — what to publish and
when — already lives in, and is recoverable from, `postiz-db` alone. What
`temporal-postgresql` backups would additionally protect is Temporal's
own execution history/audit trail and the handful of *other* background
workflows (`streak.workflow`, `digest.email.workflow`,
`refresh.token.workflow`, `generate.video.workflow` —
`apps/orchestrator/src/workflows/`) that don't have an equivalent
Post-table-style reconciliation sweep. None of those were in scope for
this investigation (it was scoped to scheduled posts specifically); worth
a follow-up ticket if their in-flight state turns out to matter enough to
justify a second backup pipeline, rather than folding it into this one
un-investigated.

## Not in this PR

Encrypted offsite copy of these backups (currently on-host, ZFS-dataset
only — protects against disk failure, not host loss / fire / ransomware
hitting the whole box). Flagged as a follow-up, not built here.
