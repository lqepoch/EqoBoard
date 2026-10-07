# Do not bake Alpaca keys into image layers.
FROM node:22-bookworm-slim AS web
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/web ./
RUN npm run build

FROM rust:bookworm AS backend
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY apps/gateway ./apps/gateway
COPY integrations/openbb ./integrations/openbb
RUN cargo build --release -p eqo-gateway

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 10001 eqo \
 && mkdir -p /var/lib/eqoboard && chown -R eqo:eqo /var/lib/eqoboard
COPY --from=backend /src/target/release/eqo-gateway /usr/local/bin/eqo-gateway
COPY --from=web /app/apps/web/dist /opt/eqoboard/web
COPY third_party/OpenTerminal-LICENSE.txt /usr/share/licenses/eqoboard/OpenTerminal-LICENSE.txt
USER eqo
WORKDIR /home/eqo
ENV EQO_BIND=0.0.0.0:8080
ENV EQO_WEB_DIST=/opt/eqoboard/web
ENV EQO_AUDIT_PATH=/var/lib/eqoboard/audit.jsonl
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/eqo-gateway"]
