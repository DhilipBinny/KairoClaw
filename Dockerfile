# Kairo — Multi-stage Production Dockerfile

# Stage 1: Dependencies (needs build tools for native modules)
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/types/package.json packages/types/
COPY packages/security/package.json packages/security/
COPY packages/mcp-client/package.json packages/mcp-client/
COPY packages/tool-platform/package.json packages/tool-platform/
COPY packages/provider-bridge/package.json packages/provider-bridge/
COPY packages/cron/package.json packages/cron/
COPY packages/memory-engine/package.json packages/memory-engine/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
# Install deps — GitHub Packages token injected via BuildKit secret (never in image layers)
RUN --mount=type=secret,id=github_token \
    if [ -f /run/secrets/github_token ]; then \
      echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/github_token)" >> .npmrc; \
    fi && \
    pnpm install && \
    sed -i '/_authToken/d' .npmrc

# Stage 2: Lint + Build (lint catches bugs, build catches type errors)
FROM deps AS build
COPY tsconfig.base.json eslint.config.js ./
COPY packages/types/ packages/types/
COPY packages/security/ packages/security/
COPY packages/mcp-client/ packages/mcp-client/
COPY packages/tool-platform/ packages/tool-platform/
COPY packages/provider-bridge/ packages/provider-bridge/
COPY packages/cron/ packages/cron/
COPY packages/memory-engine/ packages/memory-engine/
COPY packages/agent-core/ packages/agent-core/
COPY packages/core/ packages/core/
COPY packages/ui/ packages/ui/
RUN pnpm lint && \
    pnpm --filter @agw/types build && \
    pnpm --filter @agw/security build && \
    pnpm --filter @agw/mcp-client build && \
    pnpm --filter @agw/tool-platform build && \
    pnpm --filter @agw/provider-bridge build && \
    pnpm --filter @agw/cron build && \
    pnpm --filter @agw/memory-engine build && \
    pnpm --filter @agw/agent-core build && \
    pnpm --filter @agw/core build && \
    cp -r packages/core/src/db/migrations packages/core/dist/db/ && \
    pnpm --filter @agw/ui build

# Stage 3: Production (install deps + remove build tools in one layer)
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini curl git ca-certificates gosu zip \
    jq bsdmainutils poppler-utils tesseract-ocr \
    # Chromium for browse tool (headless browser automation)
    chromium \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

WORKDIR /app

# Copy built output
COPY --from=build /app/packages/types/dist packages/types/dist/
COPY --from=build /app/packages/types/package.json packages/types/
COPY --from=build /app/packages/security/dist packages/security/dist/
COPY --from=build /app/packages/security/package.json packages/security/
COPY --from=build /app/packages/mcp-client/dist packages/mcp-client/dist/
COPY --from=build /app/packages/mcp-client/package.json packages/mcp-client/
COPY --from=build /app/packages/tool-platform/dist packages/tool-platform/dist/
COPY --from=build /app/packages/tool-platform/package.json packages/tool-platform/
COPY --from=build /app/packages/provider-bridge/dist packages/provider-bridge/dist/
COPY --from=build /app/packages/provider-bridge/package.json packages/provider-bridge/
COPY --from=build /app/packages/cron/dist packages/cron/dist/
COPY --from=build /app/packages/cron/package.json packages/cron/
COPY --from=build /app/packages/memory-engine/dist packages/memory-engine/dist/
COPY --from=build /app/packages/memory-engine/package.json packages/memory-engine/
COPY --from=build /app/packages/agent-core/dist packages/agent-core/dist/
COPY --from=build /app/packages/agent-core/package.json packages/agent-core/
COPY --from=build /app/packages/core/dist packages/core/dist/
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/ui/build packages/ui/build/

# Copy browser extension for download
COPY packages/extension/ packages/extension/

# Copy root config + workspace defaults + entrypoint
COPY package.json pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY --from=build /app/pnpm-lock.yaml ./
COPY workspace-defaults/ workspace-defaults/
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Install prod deps, compile native modules, then remove build tools (one layer)
RUN --mount=type=secret,id=github_token \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && if [ -f /run/secrets/github_token ]; then \
         echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/github_token)" >> .npmrc; \
       fi \
    && pnpm install --prod \
    && sed -i '/_authToken/d' .npmrc \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

# Data directory + Claude CLI config directory (for SDK/CLI mode)
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
