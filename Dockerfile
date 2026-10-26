# syntax=docker/dockerfile:1
# Hosted mode image: runs `gmail-mcp-multi serve-http` behind a TLS proxy (see docker-compose.yml).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-slim
ENV NODE_ENV=production \
    GMAIL_MCP_HOME=/data \
    GMAIL_MCP_KEYRING=0 \
    GMAIL_MCP_NO_BROWSER=1 \
    GMAIL_MCP_HTTP_HOST=0.0.0.0 \
    GMAIL_MCP_HTTP_PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
# No OS keychain in containers: the key comes from GMAIL_MCP_MASTER_KEY instead.
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md LICENSE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GMAIL_MCP_HTTP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["serve-http"]
