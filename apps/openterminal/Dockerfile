# MIT OpenTerminal Next.js workspace; Alpaca credentials remain in Rust.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY apps/openterminal/package.json apps/openterminal/package-lock.json ./
COPY apps/openterminal/web/package.json ./web/package.json
COPY apps/openterminal/server/package.json ./server/package.json
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY apps/openterminal/server ./server
COPY apps/openterminal/web ./web
RUN npm run build -w server && npm run build -w web
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
WORKDIR /srv
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /build/package.json /srv/package.json
COPY --from=build /build/node_modules /srv/node_modules
COPY --from=build /build/web /srv/web
COPY --from=build /build/server /srv/server
RUN mkdir -p /srv/web/.next/cache /var/lib/openterminal \
    && chown -R node:node /srv/web/.next/cache /var/lib/openterminal \
    && rm -rf /srv/web/e2e /srv/web/playwright*.ts /srv/web/test-results
USER node

FROM runtime AS terminal
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "web"]

FROM runtime AS research
EXPOSE 4000
CMD ["npm", "run", "start", "-w", "server"]

# Test-only image derived from the production runtime. It adds an offline mock
# OIDC/Gateway/research process for Compose E2E; production runtime omits it.
FROM runtime AS compose-e2e
COPY --from=build --chown=node:node /build/web/e2e/mock-services.mjs /srv/e2e/mock-services.mjs
COPY --from=build --chown=node:node /build/web/e2e/compose-e2e-server.mjs /srv/e2e/compose-e2e-server.mjs
COPY --from=build --chown=node:node /build/web/e2e/fixtures/prediction-envelope-v1.synthetic.protojson /srv/e2e/fixtures/prediction-envelope-v1.synthetic.protojson
