# Kairo — Multi-stage Production Dockerfile
# Uses pnpm deploy for self-contained output (no manual package listing)

# Stage 1: Build everything
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

WORKDIR /app
COPY . .

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=github_token \
    if [ -f /run/secrets/github_token ]; then \
      echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/github_token)" >> .npmrc; \
    fi && \
    pnpm install --frozen-lockfile && \
    sed -i '/_authToken/d' .npmrc

RUN pnpm lint && \
    pnpm -r build && \
    cp -r packages/core/src/db/migrations packages/core/dist/db/ && \
    pnpm deploy --legacy --filter=@agw/core --prod /prod/core

# Stage 2: Production runtime
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini curl git ca-certificates gosu zip \
    jq bsdmainutils poppler-utils tesseract-ocr \
    chromium \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Self-contained @agw/core with all workspace deps resolved
COPY --from=build /prod/core .
# DB migrations (needed at runtime)
COPY --from=build /app/packages/core/dist/db/migrations dist/db/migrations/
# UI build (served by core, not a npm dependency)
COPY --from=build /app/packages/ui/build packages/ui/build/
# Browser extension download bundle
COPY packages/extension/ packages/extension/
# Workspace persona defaults + entrypoint
COPY workspace-defaults/ workspace-defaults/
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN mkdir -p /data /home/node/.claude && chown -R node:node /data /home/node

ENV NODE_ENV=production \
    AGW_STATE_DIR=/data \
    AGW_CONFIG=/data/config.json \
    LOG_LEVEL=info \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 18181

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:18181/api/v1/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
