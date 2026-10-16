# Legacy references and integrity baseline

This directory contains preservation metadata, not a replacement application.
Production modules must not import code from apps/openterminal or
references/legacy. The original source, tests, upstream patches and license
notices remain in their existing paths until the native migration completes all
parity, security, identity, source, persistence, performance, container and
rollback gates.

## Frozen source manifest

references/legacy/manifest-fea1e952.json records the protected source snapshot
at commit fea1e952add7a11e799d6f9f198ddcee47fd12b6 and tree
986dd808560016965e73edc1869603b621b4286e. The source is pinned by annotated
tag `migration/eqoboard-native-source-20261015-fea1e95`, tag object
9d606d11fa95ffa696aa009b52695d2c349f6a97. PR59 merged to main as
e5f0f6b7531eb73356eb4059d5cef9e37584b259 with the identical tree. The tag and
merge record establish source identity and merge history; they do not establish
native feature parity, release or deployment acceptance.

The earlier main preflight reference remains historical:

- Tag: migration/eqoboard-native-20261015-740765ec
- Tag object: 636253df34f3d7d458e4236564db5be153628ad5
- Commit: 740765ec824988eda24822b943c5604f8d565ebf

The schema-v2 manifest contains 233 protected tracked files:

- Every tracked path under `apps/openterminal`, including all existing EqoBoard
  modifications, local BFF routes, Workspace widgets, Pro panels, tests and
  notices.
- OpenBB Gateway protocol/config files under `apps/gateway/openbb`, plus its
  actual Rust implementation and tests at `apps/gateway/src/openbb.rs` and
  `apps/gateway/src/openbb_tests.rs`.
- Root MIT `LICENSE`, the OpenTerminal MIT notice, OpenBB Apache-2.0 LICENSE and
  NOTICE, all of `tools/openbb`, the OpenBB Compose files and E2E helpers.
- OpenBB Python tests `tests/test_openbb_*.py`, the OpenBB workspace skill,
  upstream and supply-chain audit records, `docs/THIRD_PARTY.md`, the local
  runtime evidence record, and `third_party/upstreams.lock.json`.

The earlier preflight manifest counted 231 protected files at main
740765ec824988eda24822b943c5604f8d565ebf. Of its paths, six shared CI files are
intentionally mutable and excluded here: `.github/workflows/openbb.yml`, the
auto-merge OpenBB check-run fixture, and the four `tools/ci/openbb-ci-{gate,route}`
source/test files:

- `.github/workflows/openbb.yml`
- `tests/fixtures/auto_merge/openbb-optional-check-runs.json`
- `tools/ci/openbb-ci-gate.mjs` and `tools/ci/openbb-ci-gate.test.mjs`
- `tools/ci/openbb-ci-route.mjs` and `tools/ci/openbb-ci-route.test.mjs`

Their original bytes remain recoverable from the pinned Git source commit and
tag; they are not immutable migration inputs. Fourteen other
paths from that preflight list were omitted by schema v1 and are now included:
the OpenBB skill, repository LICENSE, Rust implementation/tests, three OpenBB
Compose files, supply-chain/upstream audit docs, three OpenBB Python tests and
two E2E helpers:

- `.agents/skills/openbb-workspace/SKILL.md`, `LICENSE`
- `apps/gateway/src/openbb.rs`, `apps/gateway/src/openbb_tests.rs`
- `compose.openbb.e2e.yaml`, `compose.openbb.release.yaml`, `compose.openbb.yaml`
- `docs/OPENBB_SUPPLY_CHAIN.md`, `docs/UPSTREAM_AUDIT.md`
- `tests/test_openbb_community.py`, `tests/test_openbb_docker_save_oci.py`,
  `tests/test_openbb_upstream_diff.py`
- `tools/openbb-lite-e2e.sh`, `tools/openbb-sanitize-e2e-logs.mjs`

The merged PR59 tree adds eight protected paths absent from that older main
tree:

- `apps/openterminal/docs/YFINANCE_RESEARCH_CHART.md`
- `apps/openterminal/web/app/api/research/yfinance/daily/route.ts`
- `apps/openterminal/web/app/research/yfinance/[symbol]/page.tsx`
- `apps/openterminal/web/components/research/YfinanceResearchChartPage.tsx`
- `apps/openterminal/web/lib/yfinance-research-bff.ts`,
  `yfinance-research-contract.ts`, `yfinance-research-history.ts`
- `third_party/upstreams.lock.json`

Thus the complete scope is 231 - 6 + 8 = 233 files.

The manifest explicitly excludes the mutable shared CI paths above, all native
application/migration outputs, and the verifier/reference directory itself.
This keeps root-owned CI wiring editable while preserving the exact source
commit as a Git recovery point.

The manifest contains one entry per protected tracked file: canonical path,
Git mode and type, Git blob OID, byte count, raw content SHA-256, feature IDs and
provenance reference. Git's SHA-1 object identifier and raw-file SHA-256 are
separate values. The manifest also binds the main merge commit/tree separately
from the source tag and source commit, so a merge does not silently replace the
source provenance baseline.

## Source and license records

OpenTerminal is pinned to ErTasselli/OpenTerminal commit
aed097c680cd8ec1c391ae06966babe7d6d91fc6 under MIT. The lock at the frozen
snapshot does not bind an upstream Git archive SHA-256, so the manifest records
that absence instead of adopting a hash from a historical report. Keep
apps/openterminal/LICENSE with the MIT-derived source and EqoBoard changes.

The repository root LICENSE and OpenTerminal both carry MIT notices; retain
each with its distinct source. AG Grid Community is pinned to 36.2.0 under MIT.
Do not replace it with Enterprise. OpenBB Workspace is a distinct Apache-2.0 source/runtime pin at
be00e95019a55d57af146919ee46b7e1a4859226. The source archive, copied LICENSE
and NOTICE, community patch, patch runner, Dockerfile, support files and
source-lock records have separate hashes in the lock and manifest.

The OpenBB notice and supply-chain review also records commercial/proprietary
component boundaries, including TradingView Advanced Charts, AG Grid
Enterprise, AG Charts Enterprise, Highcharts and an embedded OpenBB Pro key.
OpenBB's Apache-2.0 license does not extend rights to those components. The
legacy inventory is not a rights approval for direct HLS media. Preserve
license/NOTICE bytes and review each product, source archive, patch and
distributed artifact separately.

## Verifier

Run from the repository root:

    node tools/migration/legacy-integrity.mjs

The verifier checks the fixed baseline object/tree, complete protected path
coverage, source-lock provenance, license/NOTICE and recipe hashes, Git index,
worktree bytes/modes, symlink safety and unexpected nonignored additions under
protected paths. It does not mutate files, fetch dependencies or contact a
provider.

The one-time manifest creation command is:

    node tools/migration/legacy-integrity.mjs --create-manifest

Creation is write-once and refuses to overwrite the manifest. The command reads
Git blobs from the fixed commit rather than generating a baseline from a dirty
worktree. It should only be used when intentionally establishing a new audited
source snapshot with a corresponding change to the verifier's frozen commit
constants and a review of the previous manifest history.

Integrity means only that protected source matches the recorded snapshot. It
does not prove widget parity, licensing beyond recorded notices, source
entitlement, security qualification, deployment or release acceptance. There
is no pre-acceptance deletion bypass. Do not move or delete legacy source until
all feature and rollback gates pass and a new explicit acceptance record is
approved.

The verifier's unit suite is tests/test_legacy_integrity.mjs. Per the migration
coordination brief, local tests/builds are not run; the root coordinator wires
the test lane into GitHub Actions and reports evidence for the exact candidate
SHA.

## Explicit single-file test maintenance (PR65)

On 2026-10-16 the repository owner separately authorized only the restored QQQ
cell assertion in `apps/openterminal/web/e2e/openbb-lite.spec.ts`. Its original
41,820 bytes remain in the unchanged frozen commit/tag and in
[`legacy/authorized-originals/pr65/openbb-lite.spec.ts`](legacy/authorized-originals/pr65/openbb-lite.spec.ts),
SHA-256 `593edeb81e7c8b3fce43d5d211595c982e84d47f7bc681254400a87eeef4220b`.
This is a preservation copy, outside runtime/build/TypeScript contexts.

The [authorization record](../docs/evidence/legacy-integrity-authorizations/pr65-openbb-qqq-cell.json)
binds the exact original and revised identities and the owner's narrow scope.
The verifier pins that record's identity/digest, checks the preserved original,
and accepts only that exact revised index/worktree file. It does not rewrite
the immutable 233-file manifest, permit another revision, allow wildcard
exceptions, or relax protection of any other legacy path. Removing or altering
the record or original copy fails verification. Other changes still need their
own explicit authorization and audit.
