#!/bin/sh
# soulseek-addon origin cache prune: TTL + size safety cap.
# Deletes only files neither READ nor WRITTEN in the last TTL window
# (active downloads always have a fresh mtime, so they're safe).
# With edge caching on, keep TTL short (6-12h): repeats come from the edge,
# origin just refetches from SoulSeek on edge miss. Without edge caching,
# keep 24-48h so replays don't stall on peer downloads.
# Env: TTL_HOURS (default 48), MAX_MB (default 4096), DATA_DIR (volume path).
# Runs daily via soulseek-prune.timer. Logs to /var/log/soulseek-prune.log.
D=${DATA_DIR:-/var/lib/docker/volumes/soulseek-addon_downloads/_data}
TTL_HOURS=${TTL_HOURS:-48}
MAX_MB=${MAX_MB:-4096}
[ -d "$D" ] || exit 0

TTL_MIN=$((TTL_HOURS * 60))
echo "=== $(date -u +%FT%TZ) prune start (du: $(du -sh "$D" | cut -f1), ttl: ${TTL_HOURS}h, cap: ${MAX_MB}M) ==="

# 1. TTL on stale files
find "$D" -type f -amin +"$TTL_MIN" -mmin +"$TTL_MIN" -print -delete

# 2. size cap: delete oldest-accessed first while over budget
while [ "$(du -sm "$D" | cut -f1)" -gt "$MAX_MB" ]; do
  victim=$(find "$D" -type f -printf '%A@ %p\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)
  [ -n "$victim" ] || break
  echo "cap-evict: $victim"
  rm -f "$victim"
done

# 3. drop empty album dirs
find "$D" -mindepth 1 -type d -empty -delete

echo "=== prune end (du: $(du -sh "$D" | cut -f1)) ==="
