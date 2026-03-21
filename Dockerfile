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
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
RUN pnpm install

# Stage 2: Build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/types/ packages/types/
COPY packages/core/ packages/core/
COPY packages/ui/ packages/ui/
RUN pnpm --filter @agw/types build && \
    pnpm --filter @agw/core build && \
    mkdir -p packages/core/dist/db/migrations && \
    cp packages/core/src/db/migrations/*.sql packages/core/dist/db/migrations/ && \
    pnpm --filter @agw/ui build

# Stage 3: Production deps (compile native modules, then discard build tools)
FROM node:22-bookworm-slim AS proddeps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
WORKDIR /app
COPY package.json pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY --from=build /app/packages/types/package.json packages/types/
COPY --from=build /app/packages/types/dist packages/types/dist/
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist/
RUN pnpm install --prod

# Stage 4: Final production image (no build tools)
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini curl git ca-certificates \
    jq bsdmainutils poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules (with compiled native modules)
COPY --from=proddeps /app/node_modules node_modules/

# Copy built output
COPY --from=build /app/packages/types/dist packages/types/dist/
COPY --from=build /app/packages/types/package.json packages/types/
COPY --from=build /app/packages/core/dist packages/core/dist/
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/ui/build packages/ui/build/

# Copy root config + workspace defaults + entrypoint
COPY package.json pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY workspace-defaults/ workspace-defaults/
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Data directory (use --chown to avoid extra layer)
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    AGW_STATE_DIR=/data \
    AGW_CONFIG=/data/config.json \
    LOG_LEVEL=info

USER node
EXPOSE 18181

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:18181/api/v1/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
