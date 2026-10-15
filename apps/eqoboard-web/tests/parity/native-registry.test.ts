import { describe, expect, it } from "vitest";
import { builtinWidgetRegistry } from "../../widgets/registry/builtin";
import { previewLegacyWorkspaceImport } from "../../workspace/legacy-import";
import {
  LEGACY_NATIVE_WIDGET_BINDINGS,
  LEGACY_WIDGET_TYPES,
  LEGACY_WIDGETS_RETAINED_INERT,
} from "./legacy-contract-v1";

function legacyEnvelope(types: readonly string[] = LEGACY_WIDGET_TYPES) {
  const widgets = types.map((type, index) => ({
    id: `legacy-${type}-${index}`,
    type,
    linked: true,
  }));
  return JSON.stringify({
    version: 0,
    state: {
      activeSymbol: "SPY",
      widgets,
      layout: widgets.map((widget, index) => ({
        i: widget.id,
        x: (index % 3) * 4,
        y: Math.floor(index / 3) * 3,
        w: 4,
        h: 2,
      })),
      watchlist: ["SPY", "QQQ"],
      commandOpen: false,
      optionLegs: [],
    },
  });
}

describe("legacy-to-native static registry parity", () => {
  it("accounts for every audited legacy widget as a registered manifest or an explicit inert gap", () => {
    const accountedTypes = [
      ...LEGACY_NATIVE_WIDGET_BINDINGS.map(({ legacyType }) => legacyType),
      ...LEGACY_WIDGETS_RETAINED_INERT,
    ];
    expect(new Set(accountedTypes).size).toBe(accountedTypes.length);
    expect([...accountedTypes].sort()).toEqual([...LEGACY_WIDGET_TYPES].sort());
    const mappedManifestIds = LEGACY_NATIVE_WIDGET_BINDINGS.map(({ manifestId }) => manifestId);
    expect(new Set(mappedManifestIds).size).toBe(mappedManifestIds.length);

    for (const { legacyType, manifestId } of LEGACY_NATIVE_WIDGET_BINDINGS) {
      const registration = builtinWidgetRegistry.get(manifestId);
      expect(registration?.manifest.id, `${legacyType} must resolve to ${manifestId}`).toBe(manifestId);
      expect(registration?.Component, `${manifestId} must have a statically compiled renderer`).toBeDefined();
    }
  });

  it("imports the 20-widget source inventory with exact mappings and keeps unsupported kinds inert", () => {
    const result = previewLegacyWorkspaceImport(legacyEnvelope(), builtinWidgetRegistry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tab = result.value.document.workspaces[0]?.tabs[0];
    expect(tab?.widgets).toHaveLength(LEGACY_WIDGET_TYPES.length);
    expect(result.value.retainedAsInert).toEqual(LEGACY_WIDGETS_RETAINED_INERT);

    LEGACY_NATIVE_WIDGET_BINDINGS.forEach(({ legacyType, manifestId }) => {
      const sourceIndex = LEGACY_WIDGET_TYPES.indexOf(legacyType);
      const instance = tab?.widgets[sourceIndex];
      expect(instance, legacyType).toBeDefined();
      if (!instance) return;
      expect(instance?.manifestId, legacyType).toBe(manifestId);
      expect(instance?.instanceId, legacyType).not.toBe(`legacy-${legacyType}-${sourceIndex}`);
      expect(builtinWidgetRegistry.resolveInstance(instance).status, legacyType).toBe("ready");
    });

    LEGACY_WIDGETS_RETAINED_INERT.forEach((legacyType) => {
      const sourceIndex = LEGACY_WIDGET_TYPES.indexOf(legacyType);
      const instance = tab?.widgets[sourceIndex];
      expect(instance, legacyType).toBeDefined();
      if (!instance) return;
      expect(instance?.manifestId, legacyType).toBe(`legacy.imported.${legacyType}`);
      expect(builtinWidgetRegistry.resolveInstance(instance).status, legacyType).toBe("unsupported-manifest");
    });

    expect(tab?.placements.map(({ i }) => i).sort()).toEqual(
      tab?.widgets.map(({ instanceId }) => instanceId).sort(),
    );
    expect(result.value.document.workspaces[0]?.marketContext).toEqual({
      activeSymbol: "SPY",
      watchlist: ["SPY", "QQQ"],
    });
    expect(JSON.stringify(result.value.document)).not.toMatch(/PAPER_READY|FILLED|simulator-fallback|optionLegs/u);
  });

  it("preserves the legacy nine-widget default order while resolving each tile to its actual static renderer", () => {
    const result = previewLegacyWorkspaceImport(legacyEnvelope(LEGACY_DEFAULT_WIDGETS), builtinWidgetRegistry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const widgets = result.value.document.workspaces[0]?.tabs[0]?.widgets ?? [];
    expect(widgets.map(({ manifestId }) => manifestId)).toEqual(
      LEGACY_DEFAULT_WIDGETS.map((type) => LEGACY_NATIVE_WIDGET_BINDINGS.find((binding) => binding.legacyType === type)?.manifestId),
    );
    expect(widgets).toHaveLength(LEGACY_DEFAULT_WIDGETS.length);
    expect(widgets.every((widget) => builtinWidgetRegistry.resolveInstance(widget).status === "ready")).toBe(true);
    expect(result.value.retainedAsInert).toEqual([]);
  });
});
