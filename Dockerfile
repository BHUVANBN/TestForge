# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- runtime -----------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    METRICS_PORT=9100

RUN apk add --no-cache tini

WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/temp && chown node:node /app/temp

USER node
EXPOSE 3000 9100

# Works for both API and worker processes (served by the internal metrics listener).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
