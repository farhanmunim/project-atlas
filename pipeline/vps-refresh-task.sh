#!/bin/sh
# vps-refresh-task.sh — Coolify Scheduled Task entrypoint for the static-store refresh.
# The real run (vps-refresh.sh) takes ~7–15 min, longer than Coolify's task-job
# timeout, so this detaches it and returns immediately; vps-refresh.sh's own lock
# prevents overlap. Output → /tmp/static-store-refresh.log.
set -eu
echo "[static-store-refresh] detached $(date -u +%FT%TZ) — output: /tmp/static-store-refresh.log"
nohup sh /usr/local/bin/vps-refresh.sh > /tmp/static-store-refresh.log 2>&1 &
exit 0
