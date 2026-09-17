#!/usr/bin/env bash
# Nightly pg_dump of the main socialz Postgres database, written straight
# off the NVMe the live data lives on (see docs/backlog OPS-BACKUP: a
# backup on the same disk as what it protects doesn't survive that disk
# failing).
#
# Usage: ops/backup-postgres.sh
# Env overrides (for testing against a throwaway container — never point
# these at production for a test run):
#   BACKUP_DEST         destination directory (default: /zpool_media/socialz-backups)
#   POSTGRES_CONTAINER  container to pg_dump from (default: socialz-postgres)
#   POSTGRES_USER       db user (default: postiz-user)
#   POSTGRES_DB         db name (default: postiz-db)
set -euo pipefail
umask 077

DEST="${BACKUP_DEST:-/zpool_media/socialz-backups}"
CONTAINER="${POSTGRES_CONTAINER:-socialz-postgres}"
DB_USER="${POSTGRES_USER:-postiz-user}"
DB_NAME="${POSTGRES_DB:-postiz-db}"

# Daily/weekly retention counts (see prune_backups below).
KEEP_DAILY=7
KEEP_WEEKLY=4

log() {
  printf '[backup-postgres] %s %s\n' "$(date -u +%FT%TZ)" "$*"
}

fail() {
  printf '[backup-postgres] %s ERROR: %s\n' "$(date -u +%FT%TZ)" "$*" >&2
  exit 1
}

# The destination is expected to be a dedicated ZFS dataset off the NVMe
# (see ops/README.md's `zfs create` step) — deliberately NOT `mkdir -p`ing
# a fallback here. If it's missing, backing up would silently write into
# whatever filesystem /zpool_media happens to resolve to instead, defeating
# the entire "off-NVMe, on different physical storage" point of this
# ticket. Fail loudly instead.
[[ -d "$DEST" ]] || fail "destination '$DEST' does not exist — run the zfs create step in ops/README.md first"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
partial="$DEST/${DB_NAME}_${ts}.dump.partial"
final="$DEST/${DB_NAME}_${ts}.dump"

log "starting backup of ${DB_NAME} from container ${CONTAINER} -> $partial"

# pg_dump runs inside the container against its own Unix socket (peer/trust
# auth for the local connection) via `docker exec` — no password handling
# needed here at all. -Fc (custom format) is required for pg_restore's
# --create later in ops/restore-test.sh.
if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$partial"; then
  rm -f -- "$partial"
  fail "pg_dump failed (container=$CONTAINER user=$DB_USER db=$DB_NAME) — removed partial file, no .dump written"
fi

if [[ ! -s "$partial" ]]; then
  rm -f -- "$partial"
  fail "pg_dump produced an empty file — removed partial file, no .dump written"
fi

# Only becomes a real, retained backup once pg_dump has fully succeeded —
# a reader of the destination directory should never be able to see a
# .dump file that isn't complete.
mv -- "$partial" "$final"
log "backup complete -> $final ($(stat -c%s "$final") bytes)"

# 7 daily + 4 weekly retention: keep the 7 most recent backups
# unconditionally (daily coverage), then from anything older than that,
# keep one backup per distinct ISO week for the 4 most recent such weeks,
# and delete everything else. Classification is by the timestamp encoded
# in the filename, not by mtime, so retention is deterministic and doesn't
# depend on when a file happened to be touched.
prune_backups() {
  local f base ts_part y m d week_key count
  local -a files=()
  local -a keep=()
  local -a older=()

  while IFS= read -r f; do
    files+=("$f")
  done < <(find "$DEST" -maxdepth 1 -name "${DB_NAME}_*.dump" -printf '%f\n' 2>/dev/null | sort -r)

  if [[ "${#files[@]}" -eq 0 ]]; then
    log "prune: no existing backups found, nothing to do"
    return
  fi

  # Newest KEEP_DAILY files are kept unconditionally.
  count=0
  for f in "${files[@]}"; do
    if [[ "$count" -lt "$KEEP_DAILY" ]]; then
      keep+=("$f")
    else
      older+=("$f")
    fi
    count=$((count + 1))
  done

  # From what's left (older than the daily window), keep one per distinct
  # ISO week, newest-first, until KEEP_WEEKLY distinct weeks are kept.
  local -A seen_weeks=()
  local weekly_count=0
  for f in "${older[@]}"; do
    base="${f#${DB_NAME}_}"
    ts_part="${base%.dump}"
    y="${ts_part:0:4}"
    m="${ts_part:4:2}"
    d="${ts_part:6:2}"
    week_key="$(date -u -d "${y}-${m}-${d}" +%G-%V 2>/dev/null || true)"
    [[ -n "$week_key" ]] || continue

    if [[ -z "${seen_weeks[$week_key]:-}" ]]; then
      if [[ "$weekly_count" -lt "$KEEP_WEEKLY" ]]; then
        seen_weeks["$week_key"]=1
        keep+=("$f")
        weekly_count=$((weekly_count + 1))
      fi
    fi
  done

  # Delete anything not selected above, logging each one. Newline-delimited
  # (not "${keep[*]}", which joins on a space — that silently matched
  # nothing below and pruned every file, kept ones included).
  local kept_lookup=$'\n'
  if [[ "${#keep[@]}" -gt 0 ]]; then
    kept_lookup+="$(printf '%s\n' "${keep[@]}")"$'\n'
  fi
  for f in "${files[@]}"; do
    if [[ "$kept_lookup" != *$'\n'"$f"$'\n'* ]]; then
      rm -f -- "$DEST/$f"
      log "pruned: $f"
    fi
  done
}

prune_backups
log "retention complete (keeping up to $KEEP_DAILY daily + $KEEP_WEEKLY weekly)"
