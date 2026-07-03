# Coolify deploy target for the STATIC-STORE refresh (atlas-refresh resource) —
# the VPS replacement for .github/workflows/refresh-data.yml. Build context: repo
# root, Dockerfile location /pipeline/refresh.Dockerfile. The container idles
# (sleep infinity); a Scheduled Task runs vps-refresh.sh daily at 03:17 UTC, which
# clones the repo fresh, runs the pipeline, and pushes refreshed data/*.json
# (→ Cloudflare Pages rebuild). Mount a persistent volume at /work.
FROM node:24-alpine
RUN apk add --no-cache git
COPY pipeline/vps-refresh.sh /usr/local/bin/vps-refresh.sh
RUN chmod +x /usr/local/bin/vps-refresh.sh
WORKDIR /work
CMD ["sleep", "infinity"]
