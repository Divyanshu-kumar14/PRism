# syntax=docker/dockerfile:1.7
# =============================================================================
# PRism — Multi-stage Dockerfile
# =============================================================================
# What it does:
# - Stage 1 (builder): installs deps (including dev) + compiles TypeScript (src -> dist)
# - Stage 2 (runner): production-only deps + git + non-root user + tini init
#
# Key configs:
# - NODE_ENV=production (hides dev deps, enables prod optimizations)
# - WORKSPACE_DIR/ reports/ are volumes — survive container restarts
# - Default CMD runs the 10:00 PM IST scheduler daemon; override for one-shot jobs:
#     docker run --rm --env-file .env prism digest -- --since 7d
#     docker run --rm --env-file .env prism coverage -- --focus src/lib
#
# Usage:
#   docker build -t prism .
#   docker run -d --name prism --restart unless-stopped --env-file .env \
#     -v prism_reports:/app/reports -v prism_workspace:/app/workspace prism
#   # or with compose: docker compose up -d
# =============================================================================

# ---------- Stage 1: builder ----------
FROM node:20-slim AS builder

WORKDIR /app

# Install deps first (layer cache) — copy only manifests
COPY package.json package-lock.json ./

# Use npm ci for reproducible installs; omit audit/fund for speed
RUN npm ci --ignore-scripts

# Copy source + configs needed for build
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript -> dist/
RUN npm run build

# ---------- Stage 2: runner (production) ----------
FROM node:20-slim AS runner

# Security: install git (required by GitRepoManager) + tini (PID 1 reaping) + ca-certificates
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && git --version

WORKDIR /app

ENV NODE_ENV=production
# Keep Node warnings quiet in prod but show PRism colored logs
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Create non-root user (security) — 1001 matches many PaaS expectations
RUN groupadd -r prism --gid 1001 \
  && useradd -r -g prism --uid 1001 --create-home --home-dir /home/prism prism \
  && mkdir -p /app/reports /app/workspace /app/coverage \
  && chown -R prism:prism /app

# Copy prod manifests and install prod-only deps
COPY package.json package-lock.json ./

# --omit=dev keeps image small (~180MB vs ~400MB); we already built dist/
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

# Copy compiled output from builder + runtime assets
COPY --from=builder --chown=prism:prism /app/dist ./dist
# .env.example is useful for `docker run` debugging; never copy real .env
COPY --chown=prism:prism .env.example ./
# Optional: copy README for in-container `cat` reference
COPY --chown=prism:prism README.md ./

USER prism

# Expose no port — scheduler is cron-only. If you add a health endpoint later, expose 3000.
# EXPOSE 3000

# Healthcheck: scheduler must be running (PID 1 is tini -> node). Check reports/ writable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "process.exit(require('fs').existsSync('/app/dist/scheduler.js') ? 0 : 1)"

# Use tini as init to forward SIGTERM/SIGINT to node-cron correctly
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default: run the daily 22:00 IST scheduler daemon
# Override: `docker run --rm prism node dist/digest_cli.js -- --since 7d`
#           `docker run --rm prism node dist/index.js -- --focus src/lib`
CMD ["node", "dist/scheduler.js"]
