FROM rust:bookworm AS backend
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY apps/gateway ./apps/gateway
RUN cargo build --locked --release -p eqo-gateway

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 10001 eqo \
 && mkdir -p /var/lib/eqoboard /opt/eqoboard/empty \
 && chown -R eqo:eqo /var/lib/eqoboard /opt/eqoboard/empty
COPY --from=backend /src/target/release/eqo-gateway /usr/local/bin/eqo-gateway
USER eqo
WORKDIR /home/eqo
ENV EQO_BIND=0.0.0.0:8080
ENV EQO_WEB_DIST=/opt/eqoboard/empty
ENV EQO_AUDIT_PATH=/var/lib/eqoboard/audit.jsonl
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/eqo-gateway"]
