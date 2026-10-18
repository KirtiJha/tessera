# Tessera server + console in one image.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/reporter-claude/package.json packages/reporter-claude/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @tessera/contract build \
 && pnpm --filter @tessera/server build \
 && pnpm --filter @tessera/web build \
 && pnpm --filter @tessera/reporter-claude build \
 && pnpm --filter @tessera/server --prod deploy --legacy /out/server

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S tessera && adduser -S tessera -G tessera
COPY --from=build /out/server /app/server
COPY --from=build /src/apps/web/dist /app/web/dist
COPY --from=build /src/packages/contract/dist /app/server/node_modules/@tessera/contract/dist
COPY --from=build /src/packages/contract/package.json /app/server/node_modules/@tessera/contract/package.json
USER tessera
ENV PORT=4700 HOST=0.0.0.0 WEB_DIST=/app/web/dist
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4700/api/health || exit 1
WORKDIR /app/server
CMD ["node", "dist/index.js"]
