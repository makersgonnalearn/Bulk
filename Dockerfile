FROM node:24.13.0-bookworm-slim

WORKDIR /app

ENV PORT=8080 \
    BASE_PATH=/ \
    FRONTEND_DIST_DIR=/app/artifacts/vector-workbench/dist/public \
    PYTHON_EXECUTABLE=/opt/rembg-venv/bin/python \
    U2NET_HOME=/home/node/.u2net \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_CACHE_DIR=/tmp/uv-cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      libgl1 \
      libglib2.0-0 \
      libgomp1 \
      libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.24 /uv /uvx /bin/

RUN corepack enable \
    && corepack prepare pnpm@10.26.1 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
    && PORT=8080 BASE_PATH=/ pnpm --filter @workspace/vector-workbench run build \
    && pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production

RUN uv python install 3.13 \
    && uv venv --python 3.13 /opt/rembg-venv \
    && uv pip install --python /opt/rembg-venv/bin/python \
      -r artifacts/api-server/requirements.txt \
    && rm -rf "${UV_CACHE_DIR}"

RUN mkdir -p /home/node/.u2net /tmp/vector-batch-studio/jobs \
    && chown -R node:node /home/node/.u2net /tmp/vector-batch-studio

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]