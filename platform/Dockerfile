# Build from the repository root:
# docker build -f platform/Dockerfile --target gateway .
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install --no-package-lock --no-audit --no-fund --save-exact ws@8.22.0 esbuild@0.28.2

# Explicit paths keep local credentials, databases and generated games out of
# the image.
COPY platform/package.json ./platform/package.json
COPY platform/server/ ./platform/server/
COPY platform/browser/ ./platform/browser/
COPY platform/examples/ ./platform/examples/
COPY platform/tools/ ./platform/tools/
COPY platform/nakama/build-runtime.mjs ./platform/nakama/build-runtime.mjs
COPY platform/nakama/runtime.template.js ./platform/nakama/runtime.template.js
COPY platform/nakama/migrations/ ./platform/nakama/migrations/
COPY packages/game-sdk/src/ ./packages/game-sdk/src/
RUN mkdir -p platform/nakama/runtime \
    && node platform/nakama/build-runtime.mjs \
    && node platform/tools/build-sdk.mjs

FROM heroiclabs/nakama:3.41.0 AS nakama
COPY --from=build /app/platform/nakama/runtime/index.js /nakama/data/modules/index.js
COPY platform/nakama/production.yml /nakama/data/arcane.yml

FROM node:22-alpine AS gateway
WORKDIR /app
ENV NODE_ENV=production ARCANE_BIND_HOST=0.0.0.0 ARCANE_PORT=7400
COPY --from=build /app/node_modules/ws ./node_modules/ws
COPY --from=build /app/platform ./platform
COPY --from=build /app/public/runtime/arcane-game-sdk ./public/runtime/arcane-game-sdk
USER node
EXPOSE 7400
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:7400/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "platform/server/main.mjs"]
