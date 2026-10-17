# Pine Script plugin development boundary

This package is the independently testable EqoBoard Pine Script compatibility adapter foundation. Its runtime is not deployed; track #72 and docs/PINE_SCRIPT_PLUGIN.md.

- User script execution is prohibited in Next.js, browser main thread, Rust Gateway, MDP and trading-engine. Run only in separately supervised, untrusted-code worker process after legal approval.
- No bundled PineTS or hidden AGPL runtime. License, SBOM, notice, exact pin and isolation must be reviewed before runtime integration.
- Consume validated Core Bars/MDP-only display projections with source evidence. Never fetch providers or infer entitlements. No fill-in gaps.
- All indicators are read-only. No OrderIntent, broker calls, strategy fills or alert delivery.
- Offline fake-engine tests establish only local contract invariants, not runtime sandbox security or TradingView parity.
