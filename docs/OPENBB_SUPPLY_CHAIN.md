# OpenBB Workspace supply-chain runbook

OpenBB Workspace is an optional research presentation service. Its source,
adapter patch, and image recipe are pinned in
`third_party/upstreams.lock.json`; the lock must identify the exact upstream
commit, codeload archive SHA-256, license records, patch support file hashes,
and recipe hash. Never follow the archived upstream's moving default branch.

## Verify and review source changes

From the repository root, run:

```sh
bash tools/openbb/fetch-upstream.sh
bash tools/openbb/verify-upstream.sh
bash tools/openbb/upstream-diff.sh
bash tools/openbb/source-sbom.sh
bash tools/openbb/patched-source-sbom.sh
```

`upstream-diff.sh` verifies and extracts the locked source archive, validates
the recipe and every patch support-file SHA-256, then runs the pinned patch
runner against an isolated copy. Its JSON report classifies every file as
exact upstream, modified upstream, EqoBoard-only, or deleted upstream and
records file hashes, modes, and source-tree hashes. A missing or changed
recipe, runner, patch, manifest, or source archive fails closed. The diff is a
review aid for the pinned source transformation; it is not a built-image SBOM
or browser-integration evidence.

The current Community Docker recipe intentionally accepts exactly one locked
patch and verifies that its Dockerfile copies and applies that same patch,
runner, and adjacent manifest. Adding another patch requires an explicit
recipe/contract update; the lock cannot silently describe extra source changes
that the image build does not execute.

The locked patch includes a backend portability fix for the pinned Bookworm
image: its SQLite 3.40 does not provide the `concat()` function used by the
upstream user display-name query. The patch uses SQLAlchemy string operations
(SQLite/PostgreSQL `||`, MySQL `concat()`) and the Docker build runs a SQLite
regression before Cython compilation. A prior browser attempt against the old
r3 candidate returned an API 500 on this query. The patch also removes one
unused UDF script registration from `terminalpro/index.html`; the source change
is SHA-locked and removes an unconsumed script reference rather than replacing
or rewriting the upstream UI. The current recipe identity is
`cfc03fb056e7c60226186f332d2dc7bf7eb6d30acd3de342fc7b7bb5efc77d47`.

The current identity `cfc03fb056e7c60226186f332d2dc7bf7eb6d30acd3de342fc7b7bb5efc77d47`
has a completed Community Lite r5 BuildKit build, 3/3 compiled-runtime SQLite
regressions, healthy container and HTTP 200 `/api/health`. The OCI export was
recursively checked against each descriptor size and SHA-256 blob, then
imported under a new isolated rollback tag; that imported image also reached
healthy and returned HTTP 200. The current `build-lite.sh` helper build has a
separate identity-labeled index and image SBOM; its ordered RootFS layers match
the plain r5 image. A fresh worktree sharing the same Docker daemon reran the
helper and was refused before build because the immutable identity tag already
existed. Build, health, scan, OCI and rollback records are kept in the external
artifact bundle. Those helper/source checks alone do not establish Compose
browser integration or registry publication. The prior `09028...` r4 archive and
SBOM remain separate historical evidence and do not identify the current
recipe.

## Compose and native-browser diagnostic record

The frozen code at `85621eb954d8fc2666685f87f27a58c1d96d185b` completed
attempt-20 with result `passed` and `cleanup_verified=true`:

```sh
OPENBB_E2E_SKIP_DEFAULT_PROFILE_SMOKE=1 bash tools/openbb-lite-e2e.sh
```

The diagnostic run passed three native OpenBB Playwright tests, one signed-in
OpenTerminal core-availability test while the optional OpenBB services were
stopped, and three Gateway offline/restart/image-restore browser recovery
checks. The native Workspace logged into OpenBB's own seeded email/password
account after the outer OIDC gate, completed the upstream onboarding screen,
added the three supported EqoBoard widgets, rendered SIP/OPRA protocol-mock
rows, showed pagination and entitlement errors, and preserved the terminal
session boundary. The test also restarted the actual Rust Gateway and restored
the exact saved Lite image after a deliberately broken candidate became
unhealthy. The Rust Gateway received only loopback mock endpoints for this
test; overridden provider endpoints yielded `source=unknown`, with requested
`feed=sip`/`feed=opra`. This is not evidence of live Alpaca data or entitlement.
No order was submitted and the execution mode remained disabled.

This attempt deliberately skipped the default-profile smoke to avoid repeating
an already completed Compose config/build/up check while diagnosing the browser
and rollback path. It is diagnostic lifecycle evidence, not the required final
no-skip run. The final no-skip default-profile run and image SBOM for its exact
Compose-built image remain pending; the source-helper r5 image SBOM does not
cover the Compose-built image.

Attempt-20 artifacts are retained at
`/root/.codex/artifacts/eqoboard-openbb-20261007/runtime/attempt-20/`. The
saved Docker archive SHA-256 is
`b0f3ea9430d529429f3ec77fdf4323ab99539cf941cab8c275349ae485ee9203`. Its
manifest verifier links the Docker `inspect.Id` observation
`sha256:e3f899c7b1e1ff397097b2c77afc25a5ca21ce8ec83e530959c0293a179c934f`
to the OCI index, the `linux/amd64` application manifest
`sha256:2ea08ade95908cf82bc9aa2f865711cc6eb28584bd7f4db5d912605fa93a9a67`,
and image config
`sha256:1ca37a09b7cbb4219e225762e3c0719e762f95a7ca22b7163332bd53d16b7f09`;
all config/layer descriptors are checked against archive blob sizes and
digests. Docker's local `RepoDigest` observation mirrors that local image index
and does not establish a registry publication. The Compose test tag is a
project-specific local tag, while the normal Compose recipe tag is derived
from upstream and recipe identities; neither is an immutable published
reference.

The upstream source SPDX SBOM describes the pinned archive; the patched-source
SPDX SBOM describes the verified Community patch result and frozen Bun/Poetry
dependency locks. Both are separate from a runtime image SBOM. The runtime
contains a compiled Vite bundle without Bun/npm metadata, so its image SBOM does
not enumerate the full frontend dependency graph. Keep both inventories linked
to the source tree/build record; never use source package counts as evidence
that a particular frontend image was built or served.

## License handling

Keep the upstream Apache-2.0 `LICENSE` and `NOTICE` with the source evidence
and include them in the resulting image. The pinned Community recipe must
also preserve license texts for the exact AG Grid/AG Charts Community packages
it installs. Do not ship AG Grid Enterprise, AG Charts Enterprise, Highcharts,
or other separately licensed assets without separate authorization. The
OpenBB repository's Apache license does not grant rights to those packages.

Review source patch and dependency-license changes together. Update the lock's
license records and hashes in the same explicit PR as an upstream or recipe
change. A successful Apache source check alone does not approve the license of
every bundled dependency.

## Build and rollback

`bash tools/openbb/build-lite.sh` verifies the locked source and support files,
applies the pinned patch in a temporary tree, checks the resulting build
inputs, and uses the pinned recipe for a local build. The lock's
`local-buildable` state permits that source/recipe operation only; it does not
mean the image built, passed health checks, integrated in a browser, or is
approved for deployment. Runtime Compose may use the same root-context
Dockerfile, but direct Compose builds bypass the helper's local tag conflict
guard and process lock. Helper builds hold an owner-private XDG cache lock by
full build identity and image tag, shared across worktrees for the same local
user. The lock serializes cooperating helper processes only; manual Docker or
Compose builds do not participate. Build records include the full identity,
use a unique filename, and fail rather than replace an existing record. Neither
a Compose tag nor the helper's content-specific local tag is an immutable image
digest. Debian APT package bytes do not come from a frozen
snapshot, pip bootstrap installs have version pins but no artifact hashes, and
the upstream frontend downloads webfonts without a font digest. Therefore a
repeat build can produce different image bytes even when source and recipe
hashes match.

After a successful build, record its image ID, image SBOM, the patched-source
tree and SBOM hashes, and an actual OCI manifest digest plus OCI archive SHA-256
or registry RepoDigest. The image SBOM covers the runtime filesystem; the
patched-source SBOM records the locked frontend dependency graph absent from
the compiled Vite bundle. Do not call an image config ID a RepoDigest. Keep the
complete build record with the deployment reference. No image digest or
deployment rollback target is established until those artifacts exist. The
lock's release `image_digest` remains unset. Current and earlier candidate OCI
index/archive digests are local evidence for their exact build identities, not
registry publication or a deployed rollback reference. Docker's local
`RepoDigests` field can mirror a local index and is not proof of a registry
push. Generate a new OCI artifact and SBOM for every source/recipe change; do
not reuse an earlier inventory for a changed patch.

For an image rollback, redeploy the last known healthy immutable OCI or
registry reference recorded by the deployment. Do not rebuild the failed
source under the prior image tag. For a local archive rollback test with
containerd, export all platforms and attestations, then import to a new isolated
tag without deleting the candidate:

```sh
ctr -n moby images export --local --all-platforms openbb-release.oci.tar \
  docker.io/eqoboard/openbb-workspace-lite:<release-tag>
sha256sum openbb-release.oci.tar
ctr -n moby images import --local --all-platforms \
  --index-name docker.io/eqoboard/openbb-workspace-lite:rollback-check \
  openbb-release.oci.tar
ctr -n moby images inspect \
  docker.io/eqoboard/openbb-workspace-lite:rollback-check
```

Check that the imported index still references the recorded application
manifest, config, and layers, then start the isolated tag and verify its health
endpoint before using it in a deployment rollback. Containerd may wrap the
imported OCI index with a new reference index; record both digests and compare
the nested application manifest and layer digests. Preserve the earlier image
until rollback validation has completed.

For a source or recipe rollback, revert the explicit PR that changed the
upstream lock, patch, and recipe together, then re-run source verification and
drift generation. Restore the previously saved OCI archive or registry digest;
a rebuild from the old source is a new candidate and may have different bytes
because APT packages and downloaded webfonts are not fully content-pinned.

If no previously verified image reference and build record exist, image
rollback has not been established. A source archive, source SBOM, local image
tag, or successful Docker build alone is not proof of a deployed rollback
target.
