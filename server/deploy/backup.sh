#!/bin/bash
set -euo pipefail
DB="${DB_PATH:-$HOME/.team-mem-server/data.db}"
DEST="$HOME/.team-mem-server/backups"
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 "$DB" ".backup '$DEST/data-$STAMP.db'"
# keep the newest 14
ls -1t "$DEST"/data-*.db | tail -n +15 | xargs -I{} rm -f {}
echo "backup done: $DEST/data-$STAMP.db"
