import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import type { WidgetInstanceV1, WidgetManifestV1, WidgetProps } from "../sdk/contracts";
import type { WidgetRegistration } from "./types";
import { createWidgetRegistry, WidgetRegistryDefinitionError } from "./create";

type TestConfig = Readonly<{ label: string }>;

const manifest = (id = "eqoboard.test-widget"): WidgetManifestV1 => ({
  manifestVersion: 1,
  sdkVersion: 1,
  id,
  version: "1.0.0",
  title: "Test widget",
  description: "Registry fixture.",
  category: "utility",
  rendererId: `${id}.renderer.v1`,
  configSchemaId: `${id}.config.v1`,
  defaultSize: { w: 4, h: 4, minW: 2, minH: 2, maxW: 8, maxH: 12 },
  inputs: [],
  requiredPermissions: [],
  refresh: { mode: "none" },
  symbolBinding: "unsupported",
  provenanceId: `${id}.provenance.v1`,
  provenancePolicy: "no-market-data",
});

function registration(id = "eqoboard.test-widget"): WidgetRegistration<TestConfig> {
  const Component: ComponentType<WidgetProps<TestConfig>> = () => null;
  return {
    manifest: manifest(id),
    Component,
    allowedReadOperations: [],
    allowedActions: [],
    parseConfig(value) {
      if (value !== null && typeof value === "object" &&
          typeof (value as Record<string, unknown>).label === "string" &&
          Object.keys(value).length === 1) {
        return { ok: true, value: { label: (value as { label: string }).label } };
      }
      return { ok: false, code: "config-invalid" };
    },
    createDefaultConfig() {
      return { label: "default" };
    },
    provenance: {
      provenanceId: `${id}.provenance.v1`,
      origin: "first-party",
      sourceRepository: "https://github.com/lqepoch/EqoBoard",
      sourcePath: "apps/eqoboard-web/widgets/test-fixture.tsx",
      sourceCommit: null,
      license: "MIT",
      noticePath: "LICENSE",
      auditReference: "test-fixture-only",
    },
  };
}

const instance = (overrides: Partial<WidgetInstanceV1> = {}): WidgetInstanceV1 => ({
  instanceId: "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
  manifestId: "eqoboard.test-widget",
  manifestVersion: "1.0.0",
  configSchemaId: "eqoboard.test-widget.config.v1",
  config: { label: "active" },
  ...overrides,
});

describe("static widget registry", () => {
  it("validates defaults and resolves a known instance through its static parser", () => {
    const registry = createWidgetRegistry([registration()]);
    const resolved = registry.resolveInstance(instance());
    expect(resolved.status).toBe("ready");
    if (resolved.status === "ready") {
      expect(resolved.config).toEqual({ label: "active" });
      expect(resolved.registration.manifest.id).toBe("eqoboard.test-widget");
    }
    expect(registry.parseConfig("eqoboard.test-widget.config.v1", { label: "stored" }))
      .toEqual({ ok: true, value: { label: "stored" } });
    expect(registry.list()[0]?.provenance.provenanceId)
      .toBe(registry.list()[0]?.manifest.provenanceId);
    expect(registry.list()[0]?.provenance.provenanceId)
      .not.toBe(registry.list()[0]?.manifest.id);
    expect(Object.isFrozen(registry.list()[0]?.allowedReadOperations)).toBe(true);
    expect(Object.isFrozen(registry.list()[0]?.allowedActions)).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it("returns inert statuses for unknown manifests, versions, schemas and invalid configs", () => {
    const registry = createWidgetRegistry([registration()]);
    expect(registry.resolveInstance(instance({ manifestId: "vendor.unknown" })).status)
      .toBe("unsupported-manifest");
    expect(registry.resolveInstance(instance({ manifestVersion: "2.0.0" })).status)
      .toBe("unsupported-manifest-version");
    expect(registry.resolveInstance(instance({ configSchemaId: "eqoboard.test-widget.config.v2" })).status)
      .toBe("unsupported-config-schema");
    expect(registry.resolveInstance(instance({ config: { label: 42 } })).status)
      .toBe("config-invalid");
    expect(registry.parseConfig("vendor.unknown.config.v1", {}).ok).toBe(false);
  });

  it("fails closed on malformed instances before reading registry keys", () => {
    const registry = createWidgetRegistry([registration()]);
    let called = false;
    const malformed = Object.defineProperty({}, "manifestId", {
      enumerable: true,
      get() {
        called = true;
        throw new Error("must not be read");
      },
    });
    expect(registry.resolveInstance(malformed as WidgetInstanceV1).status).toBe("invalid-instance");
    expect(called).toBe(false);
  });

  it("validates arbitrary config input before calling a registration parser", () => {
    const registry = createWidgetRegistry([registration()]);
    let called = false;
    const malformed = Object.defineProperty({}, "label", {
      enumerable: true,
      get() {
        called = true;
        throw new Error("must not be read");
      },
    });
    expect(registry.parseConfig("eqoboard.test-widget.config.v1", malformed).ok).toBe(false);
    expect(called).toBe(false);
  });

  it("rejects parser outputs that escape bounded immutable JSON config", () => {
    const invalidOutput = {
      ...registration(),
      parseConfig(value: unknown) {
        if (value && typeof value === "object" &&
            (value as Record<string, unknown>).label === "default") {
          return { ok: true as const, value: { label: "default" } };
        }
        return { ok: true as const, value: { label: (() => "executable") as unknown as string } };
      },
    };
    const registry = createWidgetRegistry([invalidOutput]);
    expect(registry.parseConfig("eqoboard.test-widget.config.v1", { label: "saved" }))
      .toEqual({ ok: false, code: "config-invalid" });
  });

  it("rejects duplicate IDs and a provenance join key that does not match", () => {
    expect(() => createWidgetRegistry([registration(), registration()])).toThrowError(
      expect.objectContaining({ code: "duplicate-manifest-id" }),
    );
    const bad = registration();
    bad.provenance = { ...bad.provenance, provenanceId: "wrong.record" };
    expect(() => createWidgetRegistry([bad])).toThrowError(
      expect.objectContaining({ code: "invalid-provenance" }),
    );
    expect(() => createWidgetRegistry([{
      ...registration(),
      createDefaultConfig: () => ({ label: "" }),
    }])).toThrowError(
      expect.objectContaining({ code: "invalid-default-config" }),
    );
    expect(WidgetRegistryDefinitionError).toBeDefined();
  });

  it("rejects malformed capability lists instead of widening a registration", () => {
    const duplicateReads = {
      ...registration(),
      allowedReadOperations: ["market.quotes", "market.quotes"],
    } as unknown as WidgetRegistration<TestConfig>;
    expect(() => createWidgetRegistry([duplicateReads])).toThrowError(
      expect.objectContaining({ code: "invalid-capabilities" }),
    );

    const unregisteredAction = {
      ...registration(),
      allowedActions: ["orders.submit"],
    } as unknown as WidgetRegistration<TestConfig>;
    expect(() => createWidgetRegistry([unregisteredAction])).toThrowError(
      expect.objectContaining({ code: "invalid-capabilities" }),
    );
  });

  it("requires adapted upstream provenance to retain safe pinned notice references", () => {
    const adapted = registration();
    adapted.provenance = {
      ...adapted.provenance,
      origin: "adapted-upstream",
      sourceCommit: "fea1e952add7a11e799d6f9f198ddcee47fd12b6",
      noticePath: "../NOTICE",
    };
    expect(() => createWidgetRegistry([adapted])).toThrowError(
      expect.objectContaining({ code: "invalid-provenance" }),
    );
  });

  it("rejects duplicate config schema, renderer, and shortcut bindings", () => {
    const first = registration("eqoboard.first-widget");
    const second = registration("eqoboard.second-widget");
    const duplicateSchema = {
      ...second,
      manifest: { ...second.manifest, configSchemaId: first.manifest.configSchemaId },
    };
    expect(() => createWidgetRegistry([first, duplicateSchema])).toThrowError(
      expect.objectContaining({ code: "duplicate-config-schema" }),
    );

    const duplicateRenderer = {
      ...second,
      manifest: { ...second.manifest, rendererId: first.manifest.rendererId },
    };
    expect(() => createWidgetRegistry([first, duplicateRenderer])).toThrowError(
      expect.objectContaining({ code: "duplicate-renderer-id" }),
    );

    const shortcutFirst = { ...first, manifest: { ...first.manifest, shortcut: "Alt+1" as const } };
    const shortcutSecond = { ...second, manifest: { ...second.manifest, shortcut: "Alt+1" as const } };
    expect(() => createWidgetRegistry([shortcutFirst, shortcutSecond])).toThrowError(
      expect.objectContaining({ code: "duplicate-shortcut" }),
    );
  });
});
