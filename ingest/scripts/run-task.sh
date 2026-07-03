#!/bin/sh
# run-task.sh <name> <command…> — wrapper for Coolify Scheduled Tasks.
#
# Coolify's ScheduledTaskJob enforces a short hard timeout, but several of our runs
# are long by design (sample-headways is a ~15–18 min multi-sweep; the weekly refresh
# ~20 min). So the task itself just launches the real command DETACHED and exits 0
# immediately — the work continues inside the container, immune to the job timeout.
#
# A per-name lock dir prevents overlapping runs (e.g. a slow sampler bleeding into
# the next 30-min slot). Locks live in /tmp: container-lifetime, so a restart can
# never leave a stale lock. Output → /tmp/task-<name>.log (check with tail).
#
# Trade-off: Coolify always sees "success" — failures live in the log files, and a
# persistently failing refresh shows up as stale data downstream.
#
# Usage (Coolify task command, working dir /app):
#   sh scripts/run-task.sh sample-headways npm run sample-headways
set -eu
NAME="$1"; shift
LOCK="/tmp/task-$NAME.lock"
LOG="/tmp/task-$NAME.log"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[$NAME] previous run still active (lock held) — skipping this slot."
  exit 0
fi
echo "[$NAME] detached $(date -u +%FT%TZ) — output: $LOG"
nohup sh -c "$* > '$LOG' 2>&1; rmdir '$LOCK'" >/dev/null 2>&1 &
exit 0
