---
name: pine-script-engine
description: EqoBoard Pine Script v5/v6 compatibility plugins, runtime licensing, isolated execution and chart integration.
---
# Pine Script Engine Skill

Read docs/PINE_SCRIPT_PLUGIN.md, packages/pine-script-plugin/AGENTS.md, apps/eqoboard-web/AGENTS.md and .agents/skills/market-charting/SKILL.md before editing.

Pine Script adapters belong to EqoBoard. Native widgets, editor and Lightweight Charts 5 renderer are EqoBoard's UI responsibility; market-data-platform owns market bars, trading-core owns exact wire semantics, quant-research owns PIT/OOS validation, and trading-engine is the future sole order authority.

Reuse reviewed upstream engines: PineTS (AGPL-3.0-only / commercial license), PyneCore runtime (Apache-2.0, separate PyneComp compiler service), and MIT PineJS transpiler when an independently licensed compatible PineJS chart host exists. Official TradingView Charting Library does not embed arbitrary Pine execution. Never claim unconditional 100% compatibility.

Never execute arbitrary Pine source in Next/browser/MDP/Engine. Require independent process isolation, real CPU-memory-wallclock kill, no egress, no credential mounts, tenant quotas, auth, logs without source leaks, versioned signed results and source integrity checks. Fake-engine tests cannot verify sandbox or official numerical parity.

Input is authorized MDP historical bars and provenance. UTC epoch seconds to PineTS milliseconds must be explicit. Do not fill absent sessions or silently request cross-symbol/timeframe bars. Unsupported features reject with a machine-readable code. Script users gain zero broker/OMS/order powers.

Track source script license, author, SHA and redistribution permissions. Protected and invite-only scripts cannot be scraped. Add golden fixtures and parity matrix for native source compatibility and plot styles prior to enabling chart editor.
