import { describe, expect, it } from "vitest";
import { createWidgetRegistry } from "../../widgets/registry/create";
import { previewLegacyWorkspaceImport } from "../../workspace/legacy-import";
import { LEGACY_DEFAULT_WIDGETS, LEGACY_WIDGET_TYPES } from "./legacy-contract-v1";

function legacyEnvelope(types: readonly string[]) {
  const widgets = types.map((type, index) => ({
    id: `legacy-widget-${index}`,
    type,
    linked: true,
  }));
  const layout = widgets.map((widget, index) => ({
    i: widget.id,
    x: (index % 3) * 4,
    y: Math.floor(index / 3) * 3,
    w: 4,
    h: 2,
  }));
  return JSON.stringify({
    version: 0,
    state: {
      activeSymbol: "SPY",
      widgets,
      layout,
      watchlist: ["SPY", "QQQ"],
      commandOpen: false,
      optionLegs: [],
    },
  });
}

const inertRegistry = createWidgetRegistry([]);

describe("legacy inventory preservation contract", () => {
  it("keeps all 20 audited legacy widget kinds explicit and unique", () => {
    expect(LEGACY_WIDGET_TYPES).toHaveLength(20);
    expect(new Set(LEGACY_WIDGET_TYPES).size).toBe(LEGACY_WIDGET_TYPES.length);
    expect(LEGACY_DEFAULT_WIDGETS).toEqual([
      "chart",
      "options",
      "quote",
      "watchlist",
      "ivskew",
      "optiontape",
      "vertical",
      "news",
      "macro",
    ]);
    expect(
      LEGACY_DEFAULT_WIDGETS.every((type) =>
        (LEGACY_WIDGET_TYPES as readonly string[]).includes(type),
      ),
    ).toBe(true);
  });

  it("preserves each audited widget as an inert, fresh-ID tile until its native renderer is registered", () => {
    const preview = previewLegacyWorkspaceImport(
      legacyEnvelope(LEGACY_WIDGET_TYPES),
      inertRegistry,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const tab = preview.value.document.workspaces[0]?.tabs[0];
    expect(tab?.widgets).toHaveLength(LEGACY_WIDGET_TYPES.length);
    expect(preview.value.widgetCount).toBe(LEGACY_WIDGET_TYPES.length);
    expect(preview.value.retainedAsInert).toEqual(LEGACY_WIDGET_TYPES);
    expect(tab?.widgets.map((widget) => widget.manifestId)).toEqual(
      LEGACY_WIDGET_TYPES.map((type) => `legacy.imported.${type}`),
    );
    expect(
      tab?.widgets.every(
        (widget) => inertRegistry.resolveInstance(widget).status === "unsupported-manifest",
      ),
    ).toBe(true);
    expect(
      tab?.widgets.every((widget, index) => widget.instanceId !== `legacy-widget-${index}`),
    ).toBe(true);
    expect(tab?.placements.map((placement) => placement.i).sort()).toEqual(
      tab?.widgets.map((widget) => widget.instanceId).sort(),
    );
    expect(preview.value.document.workspaces[0]?.marketContext).toEqual({
      activeSymbol: "SPY",
      watchlist: ["SPY", "QQQ"],
    });
    expect(JSON.stringify(preview.value.document)).not.toMatch(
      /PAPER_READY|FILLED|simulator-fallback|optionLegs/u,
    );
  });

  it("keeps all nine legacy default widgets in their original order during explicit preview", () => {
    const preview = previewLegacyWorkspaceImport(
      legacyEnvelope(LEGACY_DEFAULT_WIDGETS),
      inertRegistry,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(
      preview.value.document.workspaces[0]?.tabs[0]?.widgets.map((widget) => widget.manifestId),
    ).toEqual(LEGACY_DEFAULT_WIDGETS.map((type) => `legacy.imported.${type}`));
  });
});
