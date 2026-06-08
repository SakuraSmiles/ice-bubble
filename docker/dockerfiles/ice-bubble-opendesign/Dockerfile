# OpenDesign Daemon Dockerfile (pnpm monorepo)

FROM node:24-bookworm-slim AS builder

RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/ ./scripts/
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY tools/ ./tools/

ENV CI=true
RUN pnpm install --frozen-lockfile --registry https://registry.npmmirror.com

RUN pnpm --filter @open-design/contracts build 2>/dev/null || true \
    && pnpm --filter @open-design/registry-protocol build 2>/dev/null || true \
    && pnpm --filter @open-design/sidecar-proto build 2>/dev/null || true \
    && pnpm --filter daemon build

FROM node:24-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/package.json /package.json
COPY --from=builder /build/pnpm-workspace.yaml ./
COPY --from=builder /build/packages ./packages
COPY --from=builder /build/apps/daemon ./apps/daemon
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/node_modules/.pnpm ./node_modules/.pnpm

RUN mkdir -p .od && chown -R 1000:1000 /app
USER 1000:1000

EXPOSE 7457
CMD ["node", "apps/daemon/dist/cli.js"]
