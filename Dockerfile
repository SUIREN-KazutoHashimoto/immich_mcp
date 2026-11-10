# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.2-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM dependencies AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY contracts ./contracts
COPY web ./web
COPY immich_mcp_spec_v3.3.5 ./immich_mcp_spec_v3.3.5
RUN pnpm generate && pnpm build

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Immich MCP" \
      org.opencontainers.image.version="1.0.0-beta.3" \
      org.opencontainers.image.description="MCP bridge for Immich 3.3.5 and 3.3.6"
ENV NODE_ENV=production MCP_LISTEN_HOST=0.0.0.0 MCP_LISTEN_PORT=3000 STORAGE_PATH=/data DATABASE_PATH=/data/vault.sqlite
WORKDIR /app
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/contracts ./dist/contracts
COPY --from=build /app/dist/immich_mcp_spec_v3.3.5 ./dist/immich_mcp_spec_v3.3.5
COPY --from=build /app/dist/scripts/vault.js /app/dist/scripts/init-key.js /app/dist/scripts/healthcheck.js ./dist/scripts/
COPY immich_mcp_spec_v3.3.5/api/LICENSE.immich ./licenses/immich
COPY immich_mcp_spec_v3.3.5/api/source-manifest.json ./metadata/source-manifest.json
RUN mkdir /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node","dist/scripts/healthcheck.js","live"]
CMD ["node","dist/src/main.js"]
