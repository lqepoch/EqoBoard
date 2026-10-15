import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewLegacyWorkspaceImport } from "../../workspace/legacy-import";
import type { AnyWidgetRegistration, WidgetRegistry } from "../../widgets/registry/types";
import { researchWidgetRegistrations } from "../../widgets/research/registrations";

const recapRegistration = researchWidgetRegistrations.find(
  (registration) => registration.manifest.id === "eqoboard.research.recap",
);

const quoteRegistration: AnyWidgetRegistration = {
  manifest: {
    manifestVersion: 1,
    sdkVersion: 1,
    id: "market.quote",
    version: "1.0.0",
    title: "Quote",
    description: "Quote widget",
    category: "market",
    rendererId: "quote-card",
    configSchemaId: "market.quote.v1",
    defaultSize: { w: 4, h: 3, minW: 2, minH: 2, maxW: 12, maxH: 20 },
    inputs: [{ name: "symbol", kind: "symbol", source: "symbol-binding", required: true }],
    requiredPermissions: ["market:read"],
    refresh: { mode: "none" },
    symbolBinding: "active-or-fixed",
    provenanceId: "market.quote",
    provenancePolicy: "surface-response-evidence",
  },
  Component: () => null,
  parseConfig: (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value }
      : { ok: false, code: "config-invalid" },
  createDefaultConfig: () => ({}),
  allowedReadOperations: [],
  allowedActions: [],
  provenance: {
    provenanceId: "market.quote",
    origin: "first-party",
    sourceRepository: "EqoBoard",
    sourcePath: "apps/eqoboard-web/widgets/quote",
    sourceCommit: null,
    license: "MIT",
    noticePath: null,
    auditReference: "native migration test fixture",
  },
};

const registry = {
  get(id: string) {
    if (id === "market.quote") return quoteRegistration;
    return id === "eqoboard.research.recap" ? recapRegistration : undefined;
  },
  list() {
    return [quoteRegistration, ...(recapRegistration ? [recapRegistration] : [])];
  },
  getByShortcut() {
    return undefined;
  },
  parseConfig() {
    return { ok: false as const, code: "unsupported-config-schema" as const };
  },
  resolveInstance() {
    return { status: "unsupported-manifest" as const };
  },
} satisfies WidgetRegistry;

function legacyState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 0,
    state: {
      activeSymbol: "QQQ",
      widgets: [
        { id: "w-quote", type: "quote", linked: false, symbol: "AAPL" },
        { id: "w-old-tv", type: "tv", linked: true },
      ],
      layout: [
        { i: "w-quote", x: 0, y: 0, w: 4, h: 4 },
        { i: "w-old-tv", x: 2, y: 0, w: 4, h: 4 },
      ],
      watchlist: ["QQQ", "SPY"],
      commandOpen: true,
      optionLegs: [{ symbol: "QQQ260116C00500000", side: "buy", strike: 500, right: "call" }],
      ...overrides,
    },
  });
}

describe("explicit legacy workspace import preview", () => {
  let nextId = 1;

  beforeEach(() => {
    nextId = 1;
    vi.stubGlobal("crypto", {
      randomUUID: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("requires the audited envelope and reports unsupported versions without mutation", () => {
    expect(previewLegacyWorkspaceImport("{bad", registry).ok).toBe(false);
    expect(
      previewLegacyWorkspaceImport(JSON.stringify({ version: 1, state: {} }), registry).ok,
    ).toBe(false);
    expect(previewLegacyWorkspaceImport(legacyState({ admin: true }), registry).ok).toBe(false);
  });

  it("maps only registered manifests, assigns fresh IDs, and excludes order/transient state", () => {
    const before = legacyState();
    const result = previewLegacyWorkspaceImport(before, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sourceKey).toBe("eqoboard-open-terminal-v1");
    expect(result.value.document.workspaces[0].marketContext).toEqual({
      activeSymbol: "QQQ",
      watchlist: ["QQQ", "SPY"],
    });
    const tab = result.value.document.workspaces[0].tabs[0];
    expect(tab.widgets[0]).toMatchObject({
      manifestId: "market.quote",
      symbolBinding: { mode: "fixed", symbol: "AAPL" },
    });
    expect(tab.widgets[1].manifestId).toBe("legacy.imported.tv");
    expect(tab.widgets.map((widget) => widget.instanceId)).not.toContain("w-quote");
    expect(tab.placements.map((placement) => placement.i).sort()).toEqual(
      tab.widgets.map((widget) => widget.instanceId).sort(),
    );
    expect(result.value.retainedAsInert).toEqual(["tv"]);
    expect(result.value.excludedState).toEqual(["commandOpen", "optionLegs"]);
    expect(JSON.stringify(result.value.document)).not.toMatch(/optionLegs|commandOpen|QQQ260116C/);
    expect(legacyState()).toBe(before);
  });

  it("maps legacy recap to the registered native renderer", () => {
    expect(recapRegistration?.manifest.id).toBe("eqoboard.research.recap");
    const result = previewLegacyWorkspaceImport(
      legacyState({
        widgets: [{ id: "w-recap", type: "recap", linked: true }],
        layout: [{ i: "w-recap", x: 0, y: 0, w: 8, h: 8 }],
      }),
      registry,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const instance = result.value.document.workspaces[0]?.tabs[0]?.widgets[0];
    expect(instance?.manifestId).toBe("eqoboard.research.recap");
    expect(instance?.config).toEqual({ schemaVersion: 1 });
    expect(result.value.retainedAsInert).toEqual([]);
  });

  it("surfaces layout adjustments caused by native size and 12-column constraints", () => {
    const result = previewLegacyWorkspaceImport(
      legacyState({
        widgets: [{ id: "w-quote", type: "quote", linked: true }],
        layout: [{ i: "w-quote", x: 10, y: 0, w: 8, h: 1 }],
      }),
      registry,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.adjustedWidgetIds).toEqual([
      result.value.document.workspaces[0].tabs[0].widgets[0].instanceId,
    ]);
    expect(result.value.warnings).toContain(
      "Some legacy grid placements were adjusted to the native 12-column grid and widget size constraints.",
    );
  });

  it("rejects duplicate identities and widget/placement mismatches", () => {
    const duplicateIds = previewLegacyWorkspaceImport(
      legacyState({
        widgets: [
          { id: "same", type: "quote", linked: true },
          { id: "same", type: "tv", linked: true },
        ],
        layout: [{ i: "same", x: 0, y: 0, w: 4, h: 4 }],
      }),
      registry,
    );
    expect(duplicateIds.ok).toBe(false);

    const orphan = previewLegacyWorkspaceImport(legacyState({ layout: [] }), registry);
    expect(orphan.ok).toBe(false);
  });
});
