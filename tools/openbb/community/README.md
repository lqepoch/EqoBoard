# OpenBB Workspace Lite Community patch

This directory contains the reviewed adapter patch for OpenBB Workspace
`be00e95019a55d57af146919ee46b7e1a4859226`. The source archive SHA-256 is
`4171aa8984c7c63e171239f8cda72c4bc950f1e068de33577035dc8e5d63e6a4`.

`apply_patch.py` only accepts the extracted tree with the pinned source-root
name. Before writing anything, it verifies every modified file against the
manifest's upstream SHA-256, applies exact unified-diff hunks without fuzz, and
checks the resulting file hashes. It also removes the upstream AG license
registration through a narrow, hash-verified transform; the license text is
not copied into this patch or repository.

The adapter keeps the upstream Workspace, widgets, and AG Grid React
integration. It pins `ag-grid-community` and `ag-grid-react` to 36.2.0, removes
AG Grid/AG Charts Enterprise and Highcharts dependencies, disables Enterprise
table-chart controls, and shows an explicit unavailable state for Highcharts
and Server-Side Row Model widgets. Community sorting, filtering, and client
row rendering stay in AG Grid. The upstream startup summary no longer prints
the generated admin password; the existing explicit `credentials` command
remains available, while `secrets.env` and the admin seed config receive mode
`0600`.

From `terminalpro/`, the pinned frontend build uses the checked-in Bun lockfile
without fallback:

```sh
cd terminalpro
bun install --frozen-lockfile
bun run build:runtime
```

The source gate invokes the adapter with:

```sh
python3 tools/openbb/community/apply_patch.py \
  --source /path/to/workspace-be00e95019a55d57af146919ee46b7e1a4859226 \
  --patch tools/openbb/community/patches/community.patch
```

`community.patch.json` is the SHA-256 manifest for the upstream preimages,
approved results, and the license-call transform. The companion repository
test validates pinning, path confinement, exact hunk behavior, and key absence;
the Docker build additionally verifies the source archive and runs the real
frozen frontend build.
