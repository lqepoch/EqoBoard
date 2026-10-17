import {
  inspectPineSource, normalizePineBars, normalizePinePlots, PinePluginError,
} from "./contract.mjs";

/**
 * Runs only in an independently supervised process/container. No eval,
 * arbitrary code loader, HTTP client, or broker access is implemented here.
 * All callers must authenticate, quota and supervise the engine externally.
 */
export async function runReadOnlyPineIndicator({ source, bars, evidence, engine }) {
  if (!engine || typeof engine.evaluate !== "function" ||
      typeof engine.id !== "string" || !engine.id) {
    throw new PinePluginError("ENGINE_UNAVAILABLE", "A reviewed, isolated Pine engine is not configured.");
  }
  if (!evidence || typeof evidence !== "object" ||
      typeof evidence.provider !== "string" ||
      typeof evidence.symbol !== "string" ||
      typeof evidence.resolution !== "string" ||
      typeof evidence.completeness !== "string") {
    throw new PinePluginError("MISSING_EVIDENCE", "Source/provider/symbol/resolution/completeness evidence is mandatory.");
  }
  const info = inspectPineSource(source);
  const candles = normalizePineBars(bars);
  const result = await engine.evaluate({ source, candles, evidence, version: info.version });
  if (!result || typeof result !== "object") {
    throw new PinePluginError("ENGINE_FAILURE", "The engine returned no result.");
  }
  const plots = normalizePinePlots(result.plots, candles);
  return Object.freeze({
    protocolVersion: 1,
    language: "pine",
    version: info.version,
    kind: "indicator",
    engine: engine.id,
    executionMode: "historical-read-only",
    source: Object.freeze({
      provider: evidence.provider,
      symbol: evidence.symbol,
      resolution: evidence.resolution,
      completeness: evidence.completeness,
      feed: typeof evidence.feed === "string" ? evidence.feed : "unknown",
      delay: typeof evidence.delay === "string" ? evidence.delay : "unknown",
    }),
    barsRead: candles.length,
    plots,
    orderIntents: Object.freeze([]),
    alertDeliveries: Object.freeze([]),
  });
}
