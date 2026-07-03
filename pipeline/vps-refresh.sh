#!/bin/sh
# vps-refresh.sh — the static-store refresh, VPS edition of .github/workflows/refresh-data.yml.
#
# Runs as a Coolify Scheduled Task (daily 03:17 UTC) inside the atlas-refresh container:
# fresh shallow clone → npm ci (pdfjs only) → pipeline → hard validation gate → commit
# data/*.json as transit-instruments-bot → push (rebase-retry) → Cloudflare Pages rebuilds.
# A failed pipeline or validation aborts BEFORE the commit, so a degraded build never
# deploys — identical semantics to the retired GitHub Action.
#
# Env (Coolify resource): GIT_PUSH_TOKEN (fine-grained PAT, contents:rw on the repo),
# TFL_APP_KEY, DVLA_API_KEY (both optional, same as CI), DVLA_MAX_LOOKUPS (default 5000).
# /work is a persistent volume: keeps the clone + the HTTP validator cache (ETag /
# Last-Modified conditional requests) warm between runs.
set -eu

: "${GIT_PUSH_TOKEN:?GIT_PUSH_TOKEN not set (fine-grained PAT with contents:read/write)}"
REPO_URL="https://x-access-token:${GIT_PUSH_TOKEN}@github.com/farhanmunim/project-atlas.git"
WORK=/work/repo
CACHE=/work/http-cache
LOCK=/work/refresh.lock

# No overlapping runs (mirrors the workflow's concurrency group).
if ! mkdir "$LOCK" 2>/dev/null; then echo "Another refresh is running (lock held) — exiting."; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

echo "=== Atlas static-store refresh (VPS) $(date -u +%FT%TZ) ==="

# Fresh, current clone every run (stateless — the repo IS the state, incl. committed caches).
rm -rf "$WORK"
git clone --quiet --depth 1 --branch main "$REPO_URL" "$WORK"
cd "$WORK"

# Persist the HTTP validator cache across runs (was actions/cache in CI).
mkdir -p "$CACHE"
rm -rf .cache && ln -s "$CACHE" .cache

npm ci --omit=dev --no-audit --no-fund

DVLA_MAX_LOOKUPS="${DVLA_MAX_LOOKUPS:-5000}" node pipeline/run.js ${REFRESH_ARGS:-}

# Hard validation gate — abort before commit on any failure (set -e).
node pipeline/validate-atlas.js

git config user.name  "transit-instruments-bot"
git config user.email "bot@users.noreply.github.com"
git add data/
if git diff --cached --quiet; then
  echo "No data changes."
  exit 0
fi
git commit --quiet -m "chore(data): scheduled refresh $(date -u +%FT%TZ)"

# main may have advanced while the pipeline ran; our commit only touches data/,
# so rebase and retry rather than failing on a non-fast-forward push.
i=1
while [ $i -le 5 ]; do
  if git push origin main; then echo "Pushed on attempt $i."; exit 0; fi
  echo "Push rejected (attempt $i) — rebasing onto origin/main and retrying…"
  git pull --rebase origin main || { echo "Rebase failed — aborting."; git rebase --abort 2>/dev/null || true; exit 1; }
  sleep $((i * 3))
  i=$((i + 1))
done
echo "Could not push after 5 attempts." >&2
exit 1
