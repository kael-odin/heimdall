# ---- stage 1: build console ----
FROM node:22-bookworm-slim AS console-build
WORKDIR /app
RUN corepack enable
COPY console/package.json console/pnpm-lock.yaml ./console/
RUN cd console && pnpm install --frozen-lockfile
COPY console ./console
# AcceptanceComparison.vue 直接 import 了 ../../core/src/acceptance/comparison.mjs（零依赖的纯函数文件）。
# 这一阶段只有 console/，不补这一个文件，vite 会报 UNRESOLVED_IMPORT，整个镜像构建失败。
COPY core/src/acceptance/comparison.mjs ./core/src/acceptance/comparison.mjs
RUN cd console && pnpm build

# ---- stage 2: runtime (engine + console + playwright) ----
FROM node:22-bookworm-slim
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
# 设了 HEIMDALL_TOKEN 后 /api/* 全部要鉴权，/api/status 也不例外；不带 Token 会拿到 401，
# 容器就永远是 unhealthy。未设 Token 时头为空串，服务端不校验，照常通过。
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8900/api/status',{headers:{'x-heimdall-token':process.env.HEIMDALL_TOKEN||''}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "core/src/engine-server.mjs", "8900"]
