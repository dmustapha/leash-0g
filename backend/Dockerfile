# LEASH backend — Oracle Always-Free (amd64 micro; swap-backed).
# Monorepo-aware: builds from repo root (pnpm workspace), ships backend only.
# Env via --env-file (never baked in).
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY backend/package.json backend/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter ./backend...
COPY . .
RUN pnpm --filter ./backend build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/backend/dist ./dist
COPY --from=build /repo/backend/package.json ./
COPY --from=build /repo/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/index.js"]
