import type { NativeActionMap, NativeDataOperationMap } from "@/features/data/operations";
import type { MarketHostSnapshot } from "@/stores/market/market-store";
import type { WidgetManifestV1 } from "@/widgets/sdk/contracts";
import type { BuiltinProvenance, WidgetRegistration } from "@/widgets/registry/types";
import { PortfolioWidget, type PortfolioWidgetConfigV1 } from "./PortfolioWidget";

export type PortfolioActionId =
  | "portfolio.create"
  | "portfolio.delete"
  | "portfolio.transaction.create"
  | "portfolio.transaction.delete";

export const portfolioWidgetManifest = Object.freeze({
  manifestVersion: 1,
  sdkVersion: 1,
  id: "eqoboard.portfolio.manual-ledger",
  version: "1.0.0",
  title: "Manual portfolio ledger",
  description: "User-maintained transaction ledger with average cost and realized results. No broker positions or live valuation.",
  category: "portfolio",
  rendererId: "eqoboard.portfolio.manual-ledger.v1",
  configSchemaId: "eqoboard.portfolio.manual-ledger.v1",
  defaultSize: { w: 8, h: 8, minW: 5, minH: 5, maxW: 12, maxH: 12 },
  inputs: [],
  requiredPermissions: ["workspace:read"],
  refresh: { mode: "none" },
  symbolBinding: "unsupported",
  provenanceId: "eqoboard.native08.portfolio.manual-ledger.v1",
  provenancePolicy: "no-market-data",
} satisfies WidgetManifestV1);

export const portfolioWidgetProvenance = Object.freeze({
  provenanceId: "eqoboard.native08.portfolio.manual-ledger.v1",
  origin: "first-party",
  sourceRepository: "https://github.com/lqepoch/EqoBoard",
  sourcePath: "apps/eqoboard-web/features/portfolio/PortfolioWidget.tsx",
  sourceCommit: null,
  license: "MIT",
  noticePath: "LICENSE",
  auditReference: "apps/eqoboard-web/AGENTS.md",
} satisfies BuiltinProvenance);

export const portfolioWidgetRegistration: WidgetRegistration<
  PortfolioWidgetConfigV1,
  NativeDataOperationMap,
  Pick<NativeActionMap, PortfolioActionId>,
  MarketHostSnapshot
> = {
  manifest: portfolioWidgetManifest,
  Component: PortfolioWidget,
  allowedReadOperations: ["portfolio.list", "portfolio.positions", "portfolio.transactions"],
  allowedActions: [
    "portfolio.create",
    "portfolio.delete",
    "portfolio.transaction.create",
    "portfolio.transaction.delete",
  ],
  parseConfig(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "config-invalid" };
    const keys = Reflect.ownKeys(value);
    const record = value as Record<string, unknown>;
    return keys.length === 1 && keys[0] === "schemaVersion" && record.schemaVersion === 1
      ? { ok: true, value: Object.freeze({ schemaVersion: 1 }) }
      : { ok: false, code: "config-invalid" };
  },
  createDefaultConfig: () => ({ schemaVersion: 1 }),
  provenance: portfolioWidgetProvenance,
};
