# syntax=docker/dockerfile:1.6

FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641 AS source-patch
WORKDIR /opt
ADD --checksum=sha256:4171aa8984c7c63e171239f8cda72c4bc950f1e068de33577035dc8e5d63e6a4 https://codeload.github.com/OpenBB-finance/workspace/tar.gz/be00e95019a55d57af146919ee46b7e1a4859226 /tmp/workspace.tar.gz
RUN tar -xzf /tmp/workspace.tar.gz -C /opt
COPY tools/openbb/community/apply_patch.py /opt/openbb-community/apply_patch.py
COPY tools/openbb/community/patches/community.patch /opt/openbb-community/community.patch
COPY tools/openbb/community/patches/community.patch.json /opt/openbb-community/community.patch.json
RUN python /opt/openbb-community/apply_patch.py \
    --source /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226 \
    --patch /opt/openbb-community/community.patch

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS frontend-build
ENV NODE_OPTIONS=--max-old-space-size=8192
WORKDIR /app
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/terminalpro/package.json ./package.json
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/terminalpro/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/terminalpro/ ./
RUN grep '^VITE_RELEASE_VERSION=' .env > /tmp/release-version.env
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/lite/frontend.env ./frontend.lite.env
RUN cp ./frontend.lite.env ./.env && cat /tmp/release-version.env >> .env
RUN bun run build:runtime
RUN bunx tsc -b tsconfig.node.json

FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641 AS python-base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONIOENCODING=utf-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=100 \
    POETRY_HOME=/opt/poetry \
    POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_NO_INTERACTION=1 \
    PYSETUP_PATH=/opt \
    VENV_PATH=/opt/.venv \
    TZ=America/New_York
ENV PATH=/opt/poetry/bin:/opt/.venv/bin:$PATH

FROM python-base AS backend-build
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential git unzip \
    && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --no-cache-dir 'poetry==2.3.2'
WORKDIR /opt
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/pyproject.toml ./pyproject.toml
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/poetry.lock ./poetry.lock
RUN poetry check --lock \
    && poetry install --only main --sync --no-interaction --no-root
RUN /opt/.venv/bin/pip install --no-cache-dir 'Cython==3.3.0' 'setuptools==84.0.0'
RUN rm -rf /opt/.venv/src/slowapi/poetry.lock /opt/.venv/src/slowapi/docs/requirements.txt

FROM backend-build AS backend-compile
WORKDIR /opt/code
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/setup_compile.py ./setup_compile.py
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/api ./api
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/routers ./routers
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/utilities ./utilities
RUN . /opt/.venv/bin/activate && python setup_compile.py build_ext --inplace
RUN find api routers utilities -name '*.py' ! -name '__init__.py' | while read -r file; do \
      base="${file%.py}"; \
      if ls "${base}".cpython-*.so >/dev/null 2>&1; then rm "$file"; fi; \
    done \
    && find api routers utilities -name '*.c' -delete \
    && find . -type d -name __pycache__ -prune -exec rm -rf {} + \
    && find api routers utilities -name '*.so' -exec strip --strip-unneeded {} +
RUN /opt/.venv/bin/pip uninstall -y Cython setuptools pip 2>/dev/null || true
RUN find /opt/.venv -depth -type d -name __pycache__ -exec rm -rf {} + \
    && find /opt/.venv -depth -name '*.pyc' -delete \
    && find /opt/.venv -depth -name '*.pyo' -delete

FROM python-base AS runtime
LABEL org.opencontainers.image.source=https://github.com/OpenBB-finance/workspace \
      org.opencontainers.image.revision=be00e95019a55d57af146919ee46b7e1a4859226 \
      org.opencontainers.image.licenses=Apache-2.0 \
      org.eqoboard.openbb.variant=community-lite
RUN apt-get update \
    && apt-get install --no-install-recommends -y curl gettext-base nginx redis-server tini \
    && rm -rf /var/lib/apt/lists/* /var/log/nginx/* \
       /usr/share/doc /usr/share/man /usr/share/info /usr/share/locale \
    && mkdir -p /var/log/supervisor /run/nginx
RUN python -m pip install --no-cache-dir 'setuptools==84.0.0' 'supervisor==4.3.0'
COPY --from=backend-compile /opt/.venv /opt/.venv
RUN useradd -m -s /bin/bash appuser
WORKDIR /opt/code
COPY --from=backend-compile --chown=appuser:appuser /opt/code/api ./api
COPY --from=backend-compile --chown=appuser:appuser /opt/code/routers ./routers
COPY --from=backend-compile --chown=appuser:appuser /opt/code/utilities ./utilities
COPY --from=source-patch --chown=appuser:appuser /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/main.py ./main.py
COPY --from=source-patch --chown=appuser:appuser /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/init-db.py ./init-db.py
COPY --from=source-patch --chown=appuser:appuser /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/alembic.ini ./alembic.ini
COPY --from=source-patch --chown=appuser:appuser /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/alembic ./alembic
COPY --from=source-patch --chown=appuser:appuser /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/scripts ./scripts
COPY --from=source-patch --chown=appuser:appuser /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/backend-api/backend/workspace_mcp ./workspace_mcp
COPY --from=frontend-build /app/dist /usr/share/nginx/html
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/lite/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/lite/supervisord.conf /etc/supervisor/supervisord.conf
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/lite/entrypoint.sh /entrypoint.sh
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/lite/render-frontend-config.sh /usr/local/share/openbb/render-frontend-config.lite.sh
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/lite/render-frontend-config.full.sh /usr/local/share/openbb/render-frontend-config.full.sh
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/lite/credentials.sh /usr/local/bin/credentials
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/lite/import.sh /usr/local/bin/openbb-import
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/LICENSE /licenses/OPENBB-LICENSE
COPY --from=source-patch /opt/workspace-be00e95019a55d57af146919ee46b7e1a4859226/NOTICE /licenses/OPENBB-NOTICE
COPY --from=frontend-build /app/node_modules/ag-grid-community/LICENSE.txt /licenses/AG-GRID-COMMUNITY-LICENSE.txt
COPY --from=frontend-build /app/node_modules/ag-grid-react/LICENSE.txt /licenses/AG-GRID-REACT-LICENSE.txt
COPY --from=frontend-build /app/node_modules/ag-charts-community/LICENSE.txt /licenses/AG-CHARTS-COMMUNITY-LICENSE.txt
COPY --from=frontend-build /app/node_modules/ag-charts-react/LICENSE.txt /licenses/AG-CHARTS-REACT-LICENSE.txt
COPY --from=frontend-build /app/node_modules/ag-charts-types/LICENSE.txt /licenses/AG-CHARTS-TYPES-LICENSE.txt
RUN chmod +x /entrypoint.sh /usr/local/share/openbb/render-frontend-config.lite.sh \
      /usr/local/share/openbb/render-frontend-config.full.sh \
      /usr/local/bin/credentials /usr/local/bin/openbb-import \
    && cp /usr/local/share/openbb/render-frontend-config.lite.sh /usr/local/bin/render-frontend-config.sh
ENV PATH=/opt/.venv/bin:$PATH \
    LD_LIBRARY_PATH=/opt/.venv/lib \
    OPENBB_IMAGE_VARIANT=lite \
    PORT=3000 \
    DATABASE_TYPE=sqlite \
    DB_PATH=/data/openbb.db \
    FOLDER_STORAGE_PATH=/data/storage \
    REDIS_HOST=127.0.0.1 \
    REDIS_PORT=6379 \
    REDIS_PASS='' \
    MODE=lite \
    DISABLE_CORS=1 \
    STORAGE_PROVIDER=folder \
    EMAIL_PROVIDER=none \
    HUBSPOT=0 \
    PROMETHEUS=0 \
    WORKERS=1 \
    SUPPRESSED_API_ROUTERS='["bot", "terminal", "sdk", "run_tasks", "testing", "metrics"]' \
    SUPPRESSED_API_ROUTES='[]' \
    SELFURL=http://localhost:3000/api \
    FRONTENDURL=http://localhost:3000 \
    PROURL=http://localhost:3000
RUN mkdir -p /data /data/storage /data/redis \
    && chown appuser:appuser /data /data/storage /data/redis /opt/code
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://localhost:${PORT}/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
