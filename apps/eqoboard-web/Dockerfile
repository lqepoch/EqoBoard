# Build with apps/eqoboard-web as the Docker context:
#   docker build -f Dockerfile -t eqoboard-native-web .
# The package-lock.json is intentionally coordinator-owned and must be supplied.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# better-sqlite3 may need a source build when a matching prebuild is unavailable.
FROM base AS deps
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ findutils \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
COPY . .
RUN mkdir -p public \
    && npm run build \
    && node tools/ci/native-runtime-package-audit.mjs .next/standalone \
    && mkdir -p .legal/source .legal/dependencies \
    && find . \
      -path ./node_modules -prune -o \
      -path ./.next -prune -o \
      -path ./.legal -prune -o \
      -type f \( -iname 'license*' -o -iname 'notice*' -o -iname 'copying*' \) \
      -exec cp --parents -t .legal/source {} + \
    && find node_modules -type f \( -iname 'license*' -o -iname 'notice*' -o -iname 'copying*' \) \
      -exec cp --parents -t .legal/dependencies {} +

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    EQOBOARD_DATA_DIR=/data/eqoboard-native
RUN apt-get update \
    && apt-get install --no-install-recommends -y libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/eqoboard-native /app/legal \
    && chown node:node /data/eqoboard-native /app/legal \
    && chmod 0700 /data/eqoboard-native
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.legal ./legal/
COPY --from=builder /app/tools/ci/native-runtime-package-audit.mjs /tmp/native-runtime-package-audit.mjs
RUN node /tmp/native-runtime-package-audit.mjs /app \
    && rm /tmp/native-runtime-package-audit.mjs
VOLUME ["/data/eqoboard-native"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
