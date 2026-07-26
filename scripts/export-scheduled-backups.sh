#!/bin/sh
set -eu

readonly source_directory=/app/scheduled-backups
readonly destination_directory=/app/backups

exported=0
for manifest in "$source_directory"/stugu-backup-*/manifest.json; do
  [ -f "$manifest" ] || continue
  backup_directory=${manifest%/manifest.json}
  backup_name=${backup_directory##*/}
  destination="$destination_directory/$backup_name"

  if [ -e "$destination" ]; then
    echo "Keeping existing export: $backup_name"
    continue
  fi

  # A rootless runtime maps container root to the invoking host account, while
  # the source volume is owned by the image's UID 1000. Preserve private modes
  # and timestamps, but let the destination inherit the exporter identity.
  cp -a --no-preserve=ownership -- "$backup_directory" "$destination"
  echo "Exported scheduled backup: $backup_name"
  exported=$((exported + 1))
done

echo "Scheduled backup export complete: $exported new backup(s)"
