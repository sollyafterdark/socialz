#!/usr/bin/env bash
# Restore the newest backup into a throwaway, fully isolated Postgres
# container (no shared network, no shared volumes) and sanity-check it by
# row count. Existence of a .dump file proves nothing on its own — this
# is what catches a backup that silently can't be restored, per OPS-BACKUP.
#
# Usage: ops/restore-test.sh
# Env overrides (for testing against a throwaway backup dir — never point
# these at production for a test run):
#   BACKUP_DEST    directory to find the newest *.dump in (default: /zpool_media/socialz-backups)
#   RESTORE_DB     db name to check row counts in, must match the name the
#                  dump was taken from (default: postiz-db)
set -euo pipefail

DEST="${BACKUP_DEST:-/zpool_media/socialz-backups}"
DB_NAME="${RESTORE_DB:-postiz-db}"
IMAGE="postgres:17-alpine"
CONTAINER="socialz-restore-test-$$"

log() {
  printf '[restore-test] %s %s\n' "$(date -u +%FT%TZ)" "$*"
}

fail() {
  printf '[restore-test] %s ERROR: %s\n' "$(date -u +%FT%TZ)" "$*" >&2
  exit 1
}

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ -d "$DEST" ]] || fail "backup destination '$DEST' does not exist"

latest_dump="$(find "$DEST" -maxdepth 1 -name '*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)"
[[ -n "$latest_dump" ]] || fail "no .dump file found in $DEST"
log "testing restore of: $latest_dump"

# --network none: this container never touches socialz's app/data
# networks, and no bind mounts either — the dump gets in via `docker cp`,
# never a shared filesystem path. Trust auth is fine here: the container
# has no network reachability from outside the docker daemon's own exec
# path, and it's destroyed unconditionally on exit either way.
docker run -d --name "$CONTAINER" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" >/dev/null

log "waiting for throwaway postgres to become ready"
# The official postgres image starts up, runs initdb, then does a full
# internal restart before its final ready state — pg_isready can return
# success during the brief window between the two, right before the
# restart shuts the server back down, which then fails whatever runs
# next with "the database system is shutting down" (reproduced this
# directly). "ready to accept connections" appears in the container's
# own log twice: once before that restart, once after — wait for the
# second one instead of trusting the first successful pg_isready.
ready=0
for _ in $(seq 1 30); do
  if [[ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'database system is ready to accept connections')" -ge 2 ]]; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || fail "throwaway postgres container never became ready"

docker cp "$latest_dump" "$CONTAINER:/tmp/restore.dump"

log "restoring dump (pg_restore --create --no-owner)"
# --no-owner: this throwaway container only has the postgres superuser,
# not the app's own db role the dump's ALTER ... OWNER TO statements
# target (reproduced directly: pg_restore fails every ownership
# statement with "role ... does not exist" and exits non-zero, even
# though the actual table data restores fine). Ownership isn't what this
# test is checking — the row counts below are — and a real disaster
# restore would run against an environment that already has the app's
# db role provisioned, so this mismatch is specific to the throwaway
# test container, not a backup-quality problem.
if ! docker exec "$CONTAINER" pg_restore -U postgres -d postgres --create --no-owner /tmp/restore.dump; then
  fail "pg_restore failed — this backup cannot be restored"
fi

fail_count=0
for table in User Organization Post; do
  count="$(docker exec "$CONTAINER" psql -U postgres -d "$DB_NAME" -tAc "SELECT count(*) FROM \"$table\";" 2>/dev/null || true)"
  if [[ -z "$count" ]] || ! [[ "$count" =~ ^[0-9]+$ ]]; then
    echo "[restore-test] $(date -u +%FT%TZ) ERROR: could not query row count for \"$table\"" >&2
    fail_count=$((fail_count + 1))
    continue
  fi
  log "table \"$table\": $count rows"
  if [[ "$count" -eq 0 ]]; then
    echo "[restore-test] $(date -u +%FT%TZ) ERROR: \"$table\" has 0 rows after restore" >&2
    fail_count=$((fail_count + 1))
  fi
done

[[ "$fail_count" -eq 0 ]] || fail "$fail_count table(s) failed the row-count check"

log "restore test passed: $latest_dump restores cleanly with data in User/Organization/Post"
