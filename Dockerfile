# syntax=docker/dockerfile:1
# The api image: `node dist/main.js` (API), `node dist/worker.js` (worker), `node dist/sync.js` (create tables).
# The kits come from GitHub Packages, so the build needs a token with read:packages, passed as a secret
# (never a build arg, which would stay in the image history):
#   NODE_AUTH_TOKEN=… docker compose build          (docker-compose.yml passes it as the npm_token secret)
#   docker build --secret id=npm_token,env=NODE_AUTH_TOKEN -t mgpl-api .
# report-kit's resvg is a native module: build on the platform the image runs on (linux/amd64 or arm64).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npm_token \
    echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/npm_token)" > /root/.npmrc \
    && npm ci --no-audit --no-fund \
    && rm /root/.npmrc
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4000
# Docker's own check (compose shows "healthy"): readiness, so a replica that lost its database reads unhealthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# node is PID 1 and handles SIGTERM itself (src/lifecycle.ts): drain, finish requests, close, exit.
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
