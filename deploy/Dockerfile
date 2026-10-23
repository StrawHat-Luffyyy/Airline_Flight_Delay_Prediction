# syntax=docker/dockerfile:1
# Production images, built from the repository root:
#   docker compose -f deploy/docker-compose.prod.yml build
# Targets:
#   api  Node 22 (Debian slim), production dependencies only, the esbuild bundles (API, Kafka
#        consumer, topic init) and ml/artifacts; runs as the unprivileged `node` user.
#   web  Caddy serving the built dashboard and proxying /api to the api service.

# ---------- build: install everything, build the dashboard and the server bundles ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY web/package.json web/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build -w @flight-delay/web && npm run build -w @flight-delay/server
# This stage doubles as the `tools` image (batch and stream jobs via npm scripts), which needs the
# model artifacts for ml:register and scoring, and the BTS airport-id map for resolve:airport-ids.
COPY ml/artifacts ml/artifacts
COPY docs/airport-id-map.json docs/airport-id-map.json

# ---------- api-deps: runtime dependencies of the server workspace only ----------
# - Not --omit=peer: the lockfile flags zod (a direct dependency) as peer, so that would drop it.
# - The workspace-filtered install still leaves packages npm itself reports as extraneous (the
#   web workspace's vite toolchain); they are removed by that report, not by a hand-kept list.
# - onnxruntime-node ships every platform plus the CUDA/TensorRT providers (about 550 MB); the
#   model runs on the CPU provider, so only this architecture's CPU libraries are kept.
FROM node:22-bookworm-slim AS api-deps
ARG TARGETARCH
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY web/package.json web/
RUN npm ci --omit=dev --omit=optional --workspace=@flight-delay/server --include-workspace-root=false \
  && extraneous="$(npm ls --all --parseable --long 2>/dev/null | grep -i ':extraneous' | cut -d: -f1 || true)" \
  && if [ -n "$extraneous" ]; then rm -rf $extraneous; fi \
  && arch="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)" \
  && ort=node_modules/onnxruntime-node/bin/napi-v6 \
  && find "$ort" -mindepth 2 -maxdepth 2 -type d ! -path "$ort/linux/$arch" -exec rm -rf {} + \
  && rm -rf "$ort/darwin" "$ort/win32" \
    "$ort/linux/$arch/libonnxruntime_providers_cuda.so" "$ort/linux/$arch/libonnxruntime_providers_tensorrt.so" \
  && npm cache clean --force \
  && mkdir -p server/node_modules

# ---------- api ----------
FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
# server/package.json carries "type": "module" for the ESM bundles.
COPY --chown=root:root server/package.json server/
COPY --from=api-deps --chown=root:root /app/node_modules node_modules
COPY --from=api-deps --chown=root:root /app/server/node_modules server/node_modules
COPY --from=build --chown=root:root /app/server/dist server/dist
COPY --chown=root:root ml/artifacts ml/artifacts
# Files stay root-owned and read-only to the process; it writes nothing to disk.
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "server/dist/server.js"]

# ---------- web ----------
FROM caddy:2.10-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/web/dist /srv
