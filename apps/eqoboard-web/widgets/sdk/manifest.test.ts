import { describe, expect, it } from "vitest";
import { parseWidgetConfigData, parseWidgetInstanceV1, parseWidgetManifestV1 } from "./manifest";

const validManifest = () => ({
  manifestVersion: 1,
  sdkVersion: 1,
  id: "eqoboard.test-widget",
  version: "1.0.0",
  title: "Test widget",
  description: "A test fixture.",
  category: "utility",
  rendererId: "eqoboard.test-widget.v1",
  configSchemaId: "eqoboard.test-widget.config.v1",
  defaultSize: { w: 4, h: 4, minW: 2, minH: 2, maxW: 8, maxH: 12 },
  inputs: [],
  requiredPermissions: [],
  refresh: { mode: "none" },
  symbolBinding: "unsupported",
  provenanceId: "eqoboard.native03.test.v1",
  provenancePolicy: "no-market-data",
});

describe("widget manifest runtime validation", () => {
  it("accepts a bounded manifest and returns immutable canonical data", () => {
    const result = parseWidgetManifestV1(validManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("eqoboard.test-widget");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.defaultSize)).toBe(true);
  });

  it("rejects unknown fields, unsupported versions, invalid permissions and invalid bounds", () => {
    expect(parseWidgetManifestV1({ ...validManifest(), executable: "window.alert(1)" }).ok).toBe(false);
    expect(parseWidgetManifestV1({ ...validManifest(), entryPoint: "./plugin.js", signatureVerified: true }).ok).toBe(false);
    expect(parseWidgetManifestV1({ ...validManifest(), sdkVersion: 2 }).ok).toBe(false);
    expect(parseWidgetManifestV1({ ...validManifest(), requiredPermissions: ["admin"] }).ok).toBe(false);
    expect(parseWidgetManifestV1({
      ...validManifest(),
      defaultSize: { w: 13, h: 4, minW: 1, minH: 1, maxW: 13, maxH: 8 },
    }).ok).toBe(false);
  });

  it("rejects oversized descriptions and non-data accessor config fields without invoking getters", () => {
    expect(parseWidgetManifestV1({ ...validManifest(), description: "x".repeat(281) }).ok).toBe(false);
    let called = false;
    const accessorConfig = {};
    Object.defineProperty(accessorConfig, "value", {
      enumerable: true,
      get() {
        called = true;
        throw new Error("must not run");
      },
    });
    expect(parseWidgetConfigData(accessorConfig).ok).toBe(false);
    expect(called).toBe(false);
  });

  it("bounds config payloads and rejects oversized nested structures", () => {
    expect(parseWidgetConfigData({ value: "x".repeat(8_192) }).ok).toBe(false);
    expect(parseWidgetConfigData({ nested: Array.from({ length: 257 }, () => 1) }).ok).toBe(false);
    expect(parseWidgetConfigData({ value: Number.POSITIVE_INFINITY }).ok).toBe(false);
    const parsed = parseWidgetConfigData({ nested: [{ value: "ok" }] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.isFrozen(parsed.value)).toBe(true);
      if (parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
        expect(Object.isFrozen(parsed.value.nested)).toBe(true);
      }
    }
  });

  it("accepts structurally valid unknown IDs so the host can render them inertly", () => {
    const instance = parseWidgetInstanceV1({
      instanceId: "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
      manifestId: "vendor.unavailable-widget",
      manifestVersion: "9.2.0",
      configSchemaId: "vendor.unavailable-widget.config.v9",
      config: { preserve: true, nested: [1, "x"] },
    });
    expect(instance.ok).toBe(true);
    if (instance.ok) {
      expect(instance.value.manifestId).toBe("vendor.unavailable-widget");
      expect(Object.isFrozen(instance.value)).toBe(true);
      expect(typeof instance.value.config === "object" && instance.value.config !== null &&
        Object.isFrozen(instance.value.config)).toBe(true);
      const config = instance.value.config as { nested: readonly unknown[] };
      expect(Object.isFrozen(config.nested)).toBe(true);
    }
  });

  it("requires fixed persisted symbol bindings to use canonical workspace symbols", () => {
    const base = {
      instanceId: "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
      manifestId: "eqoboard.chart",
      manifestVersion: "1.0.0",
      configSchemaId: "eqoboard.chart.config.v1",
      config: {},
    };
    expect(parseWidgetInstanceV1({ ...base, symbolBinding: { mode: "fixed", symbol: "BRK.B" } }).ok)
      .toBe(true);
    expect(parseWidgetInstanceV1({ ...base, symbolBinding: { mode: "fixed", symbol: "brk.b" } }).ok)
      .toBe(false);
  });

  it("rejects malformed persisted fields and prototype keys", () => {
    const instance = {
      instanceId: "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
      manifestId: "eqoboard.chart",
      manifestVersion: "1.0.0",
      configSchemaId: "eqoboard.chart.config.v1",
      config: JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
      rendererId: "arbitrary-module",
    };
    expect(parseWidgetInstanceV1(instance).ok).toBe(false);
  });
});
