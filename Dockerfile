# Сборка: Nuxt → Nitro node-server (.output). В образ идёт только .output — без исходников и dev-зависимостей.
FROM node:22.22.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22.22.0-bookworm-slim
ARG COMMIT_SHA=dev
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 COMMIT_SHA=${COMMIT_SHA}
WORKDIR /app
COPY --from=build /src/.output ./.output
USER 10001
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
