# Native widget SDK V1

The native workspace renders only statically compiled registrations from
`widgets/registry/builtin.ts`. A persisted manifest ID selects data in that
catalog; it never resolves a module path or loads executable extension code.
V1 has no external plugin loader, signature trust, or third-party sandbox.

`parseWidgetManifestV1`, `parseWidgetInstanceV1`, and `parseWidgetConfigData`
validate bounded versioned data. Registration parsers provide the final
widget-specific config schema. Unsupported or malformed instances stay inert
and never mount a renderer. Adapted source provenance records are audit
metadata, not authorization or runtime trust proof.

Each registration declares `allowedReadOperations` and `allowedActions` as
closed literal arrays constrained by its feature-owned operation/action map.
An empty array grants no dispatch. `scopeWidgetHostContext(host, registration)`
enforces those declarations at runtime for `data.read`, `refresh.observe`, and
`actions.invoke`; reads and actions are bound to the active lifecycle generation
and caller abort signal. A denied or inactive operation cannot reach the
underlying host client. `createBudgetedWidgetDataClient` applies the shared host
poll budget to direct reads using the widget instance ID and opaque auth storage
partition. The refresh scheduler uses the raw host data client and applies the
same budget exactly once on its own path. Read outputs remain `unknown` at this
boundary so feature adapters validate the existing pinned Core/provider
contract instead of introducing another financial DTO.

The `market` slot remains a read-only snapshot of the shared host. Stream leases
and timers belong to the host, which applies its lifecycle, per-operation/global
budgets, and server permission checks. UI event-bus messages are workspace
commands, not market events. Every BFF request independently authenticates and
authorizes the current server session; browser permission projections are only
visibility hints.

The SDK error boundary exposes bounded error codes and safe labels, not raw
provider bodies or exception messages. Lifecycle generations abort stale work
on suspend/dispose; host schedulers own refresh timers and stop them when the
widget is inactive or hidden according to the registered policy.
Direct reads are always paused while hidden. Poll manifests retain their
declared refresh interval, one-request concurrency, and request-rate ceilings.
`shared-market` direct reads use a bounded 1-second/30-request-per-minute,
single-request default. `none` manual widgets use the same interval and rate
ceiling with a host-capped maximum of three concurrent independent reads, which
supports the portfolio's list/positions/transactions view. Global and
per-operation concurrency limits remain in force; a fourth simultaneous read
is rejected, and the ceiling does not queue work indefinitely.

The closed `useWidgetDataClient()` host hook also serves first-party manual
utilities outside a workspace registration, such as the Yahoo research page
and command palette. Those calls have no widget manifest or instance budget;
the read client still applies closed operation-to-route mapping, current
principal and permission checks, global/per-operation limits, response-size
bounds, and caller cancellation, while each BFF reauthorizes server-side. This
is not isolation between modules in the compiled bundle, and external plugins
are not supported.
