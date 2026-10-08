# ---- stage 1: build console ----
FROM node:24-bookworm-slim AS console-build
WORKDIR /app
RUN corepack enable
COPY console/package.json console/pnpm-lock.yaml ./console/
RUN cd console && pnpm install --frozen-lockfile
COPY console ./console
RUN cd console && HEIMDALL_SKIP_WORKSPACE=1 pnpm build

# ---- stage 2: runtime (engine + console + playwright) ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HEIMDALL_HOST=0.0.0.0 \
    HEIMDALL_DATA_DIR=/data \
    HEIMDALL_CONSOLE_DIR=/app/console/dist \
    HEIMDALL_LLM=0
WORKDIR /app
RUN corepack enable
COPY core/package.json core/pnpm-lock.yaml ./core/
RUN cd core && pnpm install --frozen-lockfile
# recon/forge/diff 需要 Chromium（控制台浏览历史产物不需要，但完整能力需要）
RUN cd core && pnpm exec playwright install --with-deps chromium
COPY core ./core
COPY --from=console-build /app/console/dist ./console/dist
VOLUME ["/data"]
EXPOSE 8900
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8900/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "core/src/engine-server.mjs", "8900"]
