# Coolify deploy target for the ingest/ warehouse pipeline. This container stays
# idle (sleep infinity) — Coolify Scheduled Tasks `docker exec` into it to run
# each npm script on its own cron, replacing the old GitHub Actions workflows.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
CMD ["sleep", "infinity"]
