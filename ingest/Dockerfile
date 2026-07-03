# Coolify deploy target for the ingest/ warehouse pipeline. This container stays
# idle (sleep infinity) — Coolify Scheduled Tasks `docker exec` into it to run
# each npm script on its own cron, replacing the old GitHub Actions workflows.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# --include=dev: this pipeline's runtime deps (@supabase/supabase-js, pdfjs-dist, …)
# are declared under devDependencies, and Coolify builds with NODE_ENV=production
# (which would otherwise omit them). They're needed at runtime, so force them in.
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
CMD ["sleep", "infinity"]
