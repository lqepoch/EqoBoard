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
r3 candidate returned an API 500 on this query. That candidate used the
previous patch and has a different build identity; it is not evidence for the
currently locked recipe. The r4 image and browser retest remain pending.

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
lock's release `image_digest` remains unset. The previous r3 candidate's OCI
index and archive digests are host-local evidence for the previous patch, not
the current recipe, a registry publication, or a deployed rollback reference.
Generate a new OCI artifact and SBOM only from the current recipe; do not reuse
the r3 inventory for the changed patch.

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
