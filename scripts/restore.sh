#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: restore.sh <dumpfile> [--yes]" >&2
}

if (( $# < 1 || $# > 2 )); then
    usage
    exit 2
fi

dump_file=$1
assume_yes=false
if (( $# == 2 )); then
    if [[ "$2" != "--yes" ]]; then
        usage
        exit 2
    fi
    assume_yes=true
fi

database_url=${AUTOLAB_PG_URL:-${AUTOLAB_DB_URL:-${DATABASE_URL:-}}}
if [[ -z "$database_url" ]]; then
    echo "set AUTOLAB_PG_URL or AUTOLAB_DB_URL to the restore database" >&2
    exit 2
fi
if [[ "$database_url" == postgresql+psycopg://* ]]; then
    database_url="postgresql://${database_url#postgresql+psycopg://}"
fi

if [[ ! -f "$dump_file" || ! -r "$dump_file" ]]; then
    echo "dump file is not a readable regular file: $dump_file" >&2
    exit 2
fi

if [[ "$assume_yes" == false ]]; then
    echo "This will replace database objects using: $dump_file" >&2
    printf 'Type RESTORE to continue: ' >&2
    if ! IFS= read -r confirmation; then
        echo "restore cancelled" >&2
        exit 1
    fi
    if [[ "$confirmation" != "RESTORE" ]]; then
        echo "restore cancelled" >&2
        exit 1
    fi
fi

pg_restore --clean --if-exists --single-transaction -d "$database_url" --exit-on-error "$dump_file"
