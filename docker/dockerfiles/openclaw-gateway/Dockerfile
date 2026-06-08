# OpenClaw Gateway Dockerfile
# Multi-stage build: install deps globally, then copy runtime only

FROM node:24-bookworm-slim AS builder

# Use mirrors
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update

WORKDIR /app

# Install openclaw globally (same as host)
RUN npm install -g --registry https://registry.npmmirror.com openclaw

FROM node:24-bookworm-slim AS runtime

# Install chromium, docker CLI (official), fonts
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       ca-certificates \
       gnupg \
       fonts-noto-cjk \
       curl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy openclaw from builder
COPY --from=builder /usr/local/lib/node_modules/openclaw /usr/local/lib/node_modules/openclaw
COPY --from=builder /usr/local/bin/openclaw /usr/local/bin/openclaw

# Set chromium path for playwright/puppeteer
ENV CHROME_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
EXPOSE 18789

CMD ["node", "/usr/local/lib/node_modules/openclaw/dist/index.js", "gateway", "--port", "18789", "--bind", "lan"]
