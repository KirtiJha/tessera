# Tessera server + console in one image.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/reporter-claude/package.json packages/reporter-claude/
COPY packages/cli/package.json packages/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @tessera/contract build \
 && pnpm --filter @tessera/server build \
 && pnpm --filter @tessera/web build \
 && pnpm --filter @tessera/reporter-claude build \
 && pnpm --filter @tessera/cli build \
 && pnpm --filter @tessera/server --prod deploy --legacy /out/server

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S -g 10001 tessera && adduser -S -u 10001 -G tessera tessera
COPY --from=build /out/server /app/server
COPY --from=build /src/apps/web/dist /app/web/dist
COPY --from=build /src/packages/reporter-claude/release/tessera-reporter.tgz /app/downloads/tessera-reporter.tgz
COPY --from=build /src/packages/reporter-claude/release/tessera-reporter.mjs /app/downloads/tessera-reporter.mjs
COPY --from=build /src/packages/cli/release/tessera-cli.tgz /app/downloads/tessera-cli.tgz
COPY --from=build /src/packages/contract/dist /app/server/node_modules/@tessera/contract/dist
COPY --from=build /src/packages/contract/package.json /app/server/node_modules/@tessera/contract/package.json
USER tessera
ENV PORT=4700 HOST=0.0.0.0 WEB_DIST=/app/web/dist REPORTER_TGZ=/app/downloads/tessera-reporter.tgz CLI_TGZ=/app/downloads/tessera-cli.tgz
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
WORKDIR /app/server
CMD ["node", "dist/index.js"]
