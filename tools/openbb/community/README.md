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
integration. It pins `ag-grid-community` and `ag-grid-react` to 36.2.0 and
`ag-charts-community` and `ag-charts-react` to 14.2.0. AG Grid 36.2.0 pins its
`ag-charts-types` dependency to 14.2.0, so the standalone Community chart
packages use the matching type release. It removes AG Grid/AG Charts Enterprise
and Highcharts dependencies, disables Enterprise table-chart controls, and
shows an explicit unavailable state for Highcharts, Server-Side Row Model,
SQL-grid, and integrated chart-from-table widgets. Community sorting, filtering,
client row rendering, and standalone Community charts stay in their native
upstream components. The upstream startup summary no longer prints
the generated admin password; the existing explicit `credentials` command
remains available, while `secrets.env` and the admin seed config receive mode
`0600`.

The patch also aligns the upstream TypeScript deprecation setting with the
locked TypeScript 5.9 compiler and updates three Zod 4 type-only casts from the
removed `AnyZodObject` alias to `ZodObject`. Runtime validation and Lite strict
triage behavior are unchanged. The pinned project-reference build passes. The
upstream full `tsc --noEmit` script still reports 185 existing TypeScript
diagnostics with the pinned source and frozen upstream dependencies; the
Community patch adds no diagnostics against that baseline. The Docker image
build runs `tsc -b tsconfig.node.json`; the full `bun run typecheck` is checked
separately and remains a failing baseline check.

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
the Docker build uses BuildKit's checksum-verified upstream archive, frozen
frontend install, actual frontend bundle build, and project-reference type
build. A successful image build does not imply that the separate full frontend
typecheck passed; that command currently fails on the same 185 pinned-upstream
diagnostics as the unpatched source.

The base image references and upstream source are digest/commit pinned, and the
frontend uses its frozen Bun lockfile. The image is not claimed to be
bit-for-bit reproducible: Debian package indexes and the pinned-version pip
bootstrap installs are not backed by repository snapshots and per-artifact
hash locks. Release evidence therefore records the built OCI manifest digest
and image SBOM for rollback instead of treating a rebuild as byte-identical.
