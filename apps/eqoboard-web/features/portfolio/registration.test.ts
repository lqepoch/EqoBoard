import { describe, expect, it } from "vitest";
import { portfolioWidgetManifest, portfolioWidgetRegistration } from "./registration";

describe("manual portfolio widget registration", () => {
  it("declares a first-party manual ledger without market authority", () => {
    expect(portfolioWidgetManifest.id).toBe("eqoboard.portfolio.manual-ledger");
    expect(portfolioWidgetManifest.configSchemaId).toBe("eqoboard.portfolio.manual-ledger.v1");
    expect(portfolioWidgetManifest.requiredPermissions).toEqual(["workspace:read"]);
    expect(portfolioWidgetManifest.provenancePolicy).toBe("no-market-data");
    expect(portfolioWidgetRegistration.provenance.provenanceId).toBe("eqoboard.native08.portfolio.manual-ledger.v1");
  });

  it("accepts only the versioned empty config and returns a fresh default", () => {
    expect(portfolioWidgetRegistration.parseConfig({ schemaVersion: 1 })).toEqual({ ok: true, value: { schemaVersion: 1 } });
    expect(portfolioWidgetRegistration.parseConfig({ schemaVersion: 1, portfolioId: 42 })).toEqual({ ok: false, code: "config-invalid" });
    const first = portfolioWidgetRegistration.createDefaultConfig();
    const second = portfolioWidgetRegistration.createDefaultConfig();
    expect(first).toEqual({ schemaVersion: 1 });
    expect(first).not.toBe(second);
  });
});
