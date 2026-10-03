#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
    echo "Usage: backup.sh [database-url] [target-dir] [retention-count]" >&2
    echo "Set AUTOLAB_PG_URL (or AUTOLAB_DB_URL), AUTOLAB_BACKUP_DIR," >&2
    echo "and AUTOLAB_BACKUP_RETENTION instead of positional arguments." >&2
}

if (( $# > 3 )); then
    usage
    exit 2
fi

database_url=${1:-${AUTOLAB_PG_URL:-${AUTOLAB_DB_URL:-${DATABASE_URL:-}}}}
target_dir=${2:-${AUTOLAB_BACKUP_DIR:-}}
retention_count=${3:-${AUTOLAB_BACKUP_RETENTION:-14}}

if [[ -z "$database_url" || -z "$target_dir" ]]; then
    usage
    exit 2
fi

if [[ ! "$retention_count" =~ ^[0-9]+$ ]]; then
    echo "retention-count must be a positive integer" >&2
    exit 2
fi
retention_count=$((10#$retention_count))
if (( retention_count < 1 )); then
    echo "retention-count must be a positive integer" >&2
    exit 2
fi

if [[ "$database_url" == postgresql+psycopg://* ]]; then
    database_url="postgresql://${database_url#postgresql+psycopg://}"
fi

mkdir -p -- "$target_dir"
target_dir=$(cd -- "$target_dir" && pwd -P)
chmod 0700 "$target_dir"
dump_file="$target_dir/autolab_$(date +%Y%m%d_%H%M%S).dump"
partial_dump="$dump_file.partial"

cleanup_partial_dump() {
    rm -f -- "$partial_dump"
}
trap cleanup_partial_dump EXIT

pg_dump -Fc --file="$partial_dump" "$database_url"
mv -- "$partial_dump" "$dump_file"
chmod 0600 "$dump_file"
trap - EXIT

dump_files=("$target_dir"/autolab_*.dump)
if [[ ! -e "${dump_files[0]}" ]]; then
    dump_files=()
fi

prune_count=$((${#dump_files[@]} - retention_count))
for ((index = 0; index < prune_count; index++)); do
    old_dump=${dump_files[$index]}
    if [[ "$old_dump" != "$target_dir"/autolab_*.dump ]]; then
        echo "refusing to prune file outside the backup target: $old_dump" >&2
        exit 1
    fi
    rm -- "$old_dump"
done

printf '%s\n' "$dump_file"
