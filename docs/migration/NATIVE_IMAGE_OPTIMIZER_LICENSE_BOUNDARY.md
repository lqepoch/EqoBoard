# Native image optimizer and CSS build-tool boundary

The native terminal currently has no `next/image` imports. Its standalone server does not need Next's image optimizer; `apps/eqoboard-web/next.config.mjs` sets `images.unoptimized: true` and excludes only the locked Sharp/libvips and Lightning CSS package families from server output tracing. This is a deployment boundary, not a change to the source dependency graph.

The source lock continues to pin Next.js `15.5.27`, Sharp `0.35.5`, libvips packages `1.3.4`, and Lightning CSS `1.32.0`. Sharp is an optional image-optimization chain; Lightning CSS is a build-only CSS transform. The exact package path, version, npm integrity, and SPDX expression for every locked package in those families is captured in `tools/ci/native-runtime-excluded-license-inventory.json`, with those roles kept distinct. The license auditor checks that inventory against `apps/eqoboard-web/package-lock.json`, validates SPDX expression syntax, compares installed package metadata, and fails on missing, added, changed, or stale entries. LGPL- and MPL-bearing source packages are accepted only as exact inventoried inputs whose package families must be absent from runtime artifacts; their licenses are not globally added to the permissive allowlist.

`apps/eqoboard-web/Dockerfile` checks both `.next/standalone` and the final `/app` filesystem for installed `sharp`, `@img/sharp-*`, and `lightningcss*` packages, known Sharp/Lightning CSS native module names, and libvips shared-library names. The scanner also fails on unresolved or out-of-root symlinks. This detects the known locked package and binary layouts; it does not claim to identify every arbitrary opaque binary rename. The independent runtime image SBOM supplies package-name evidence as a second check. The final-image check runs after runtime files are copied and before the image is finalized. The final image still carries full source and dependency `LICENSE*`, `NOTICE*`, and `COPYING*` files under `/app/legal`; the runtime audit skips only that text-only archive. It does not skip application or `node_modules` content.

The runtime-exclusion inventory is coupled to the committed package lock by exact `integrity` values. A dependency update that changes its version, bytes, license expression, or package family requires a deliberate inventory review and a new runtime-image check. SPDX `WITH` expressions remain syntactically parsed but are rejected by the current license policy because no exception identifier is separately reviewed. Do not resolve license failures by adding LGPL/MPL to the general permissive allowlist or deleting source notices.

The Next.js settings follow the [Next.js 15 output tracing configuration](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/output) and the [Image component's `unoptimized` option](https://nextjs.org/docs/app/api-reference/components/image#unoptimized). Those docs describe configuration behavior; CI's standalone and final-image checks establish whether the locked candidate actually omits the packages.

## Required validation commands

Run the focused policy and artifact-audit unit tests with Node's built-in runner, then the lock-backed license audit:

```bash
node --test tools/ci/native-license-policy.test.mjs tools/ci/native-runtime-package-audit.test.mjs
node tools/ci/native-license-audit.mjs
```

The native Dockerfile performs both artifact scans during the `runtime` image build. Keep the Actions image build on the `runtime` target so that the final filesystem scan is required for the candidate image.
