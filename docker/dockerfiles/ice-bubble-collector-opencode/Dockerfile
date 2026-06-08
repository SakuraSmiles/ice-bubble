# Ice Bubble Collector OpenCode Dockerfile
# Minimal image - all node_modules bind-mounted from host

FROM node:24-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p logs && chown -R 1000:1000 /app
USER 1000:1000

EXPOSE 13101
CMD ["node", "dist/start.js"]
