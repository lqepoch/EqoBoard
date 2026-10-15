import { describe, expect, it } from "vitest";
import type { WidgetInstanceV1, WidgetJsonValueV1 } from "../sdk/contracts";
import { builtinWidgetRegistry } from "./builtin";

describe("compiled builtin widget registry", () => {
  it("resolves only its frozen registrations and validates each registered default config", () => {
    const registrations = builtinWidgetRegistry.list();
    expect(registrations.length).toBeGreaterThan(0);
    expect(Object.isFrozen(registrations)).toBe(true);

    registrations.forEach((registration, index) => {
      expect(builtinWidgetRegistry.get(registration.manifest.id)).toBe(registration);
      expect(Object.isFrozen(registration)).toBe(true);
      expect(Object.isFrozen(registration.manifest)).toBe(true);
      expect(registration.provenance.provenanceId).toBe(registration.manifest.provenanceId);

      const config = registration.createDefaultConfig();
      expect(
        builtinWidgetRegistry.parseConfig(registration.manifest.configSchemaId, config).ok,
      ).toBe(true);
      const instance: WidgetInstanceV1 = {
        instanceId: `80e310b0-4a9e-4b0b-b500-${String(index + 1).padStart(12, "0")}`,
        manifestId: registration.manifest.id,
        manifestVersion: registration.manifest.version,
        configSchemaId: registration.manifest.configSchemaId,
        config: config as WidgetJsonValueV1,
      };
      expect(builtinWidgetRegistry.resolveInstance(instance).status).toBe("ready");
    });
  });
});
