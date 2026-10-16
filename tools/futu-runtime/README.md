# Futu SDK runtime

This private package contains only the pinned `futu-api` SDK and its locked
runtime dependency closure. It is installed separately from the legacy
OpenTerminal app so the native local worker does not resolve packages through
the old Node server or depend on that server's package manifest.

Install the reviewed lockfile with:

```powershell
npm ci --prefix tools/futu-runtime --ignore-scripts
```

The worker and its SDK contract test resolve modules from this package. The
package has no application scripts, server entry point, HTTP service, trading
capabilities, or provider credentials. `tools/futu-stdio.mjs` is a local
read-only transport worker that connects only to the configured loopback Futu
OpenD WebSocket endpoint; Rust Gateway remains responsible for HTTP
authentication and browser streaming.

The dependency versions, registry URLs, integrity hashes, dependency metadata,
and third-party license identifiers in `package-lock.json` are extracted from
the repository's existing OpenTerminal lockfile for the same approved SDK
version. The legacy application source and lockfile remain unchanged.
