import { describe, expect, it } from "vitest";
import { fromGridCallback, keyboardMove, placementsOverlap } from "../../workspace/grid";
import type { WidgetRegistry } from "../../widgets/registry/types";
import type { WorkspaceTabV1 } from "../../workspace/model";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const thirdId = "44444444-4444-4444-8444-444444444444";

const tab: WorkspaceTabV1 = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Layout",
  widgets: [
    {
      instanceId: firstId,
      manifestId: "native.chart",
      manifestVersion: "1.0.0",
      configSchemaId: "native.chart.v1",
      config: {},
    },
    {
      instanceId: secondId,
      manifestId: "native.quote",
      manifestVersion: "1.0.0",
      configSchemaId: "native.quote.v1",
      config: {},
    },
  ],
  placements: [
    { i: firstId, x: 0, y: 0, w: 4, h: 3 },
    { i: secondId, x: 4, y: 0, w: 4, h: 3 },
  ],
  maximizedInstanceId: null,
};

const registry = {
  get: () => undefined,
} as unknown as WidgetRegistry;

describe("native workspace layout acceptance", () => {
  it("resolves overlapping grid callbacks into stable, non-overlapping placements", () => {
    const result = fromGridCallback(
      [
        { i: firstId, x: 0, y: 0, w: 4, h: 3 },
        { i: secondId, x: 2, y: 0, w: 4, h: 3 },
      ],
      tab,
      registry,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placements).toHaveLength(2);
    expect(result.placements.some((item) => item.i === secondId && item.y >= 3)).toBe(true);
    expect(
      result.placements.every(
        (item) => item.x >= 0 && item.x + item.w <= 12 && item.y + item.h <= 500,
      ),
    ).toBe(true);
    for (let left = 0; left < result.placements.length; left += 1) {
      for (let right = left + 1; right < result.placements.length; right += 1) {
        expect(placementsOverlap(result.placements[left], result.placements[right])).toBe(false);
      }
    }
  });

  it("keeps the moved item in bounds and pushes collisions instead of persisting overlap", () => {
    const result = keyboardMove(tab.placements, firstId, "ArrowRight");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.placements.find((item) => item.i === firstId)).toMatchObject({ x: 1, y: 0 });
    for (let left = 0; left < result.placements.length; left += 1) {
      for (let right = left + 1; right < result.placements.length; right += 1) {
        expect(placementsOverlap(result.placements[left], result.placements[right])).toBe(false);
      }
    }
  });

  it("resolves a multi-widget collision chain without colliding a pushed item with itself", () => {
    const placements = [
      { i: firstId, x: 0, y: 0, w: 4, h: 3 },
      { i: secondId, x: 4, y: 0, w: 4, h: 3 },
      { i: thirdId, x: 4, y: 3, w: 4, h: 3 },
    ];

    const result = keyboardMove(placements, firstId, "ArrowRight");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placements).toEqual([
      { i: firstId, x: 1, y: 0, w: 4, h: 3 },
      { i: secondId, x: 4, y: 3, w: 4, h: 3 },
      { i: thirdId, x: 4, y: 6, w: 4, h: 3 },
    ]);
    for (let left = 0; left < result.placements.length; left += 1) {
      for (let right = left + 1; right < result.placements.length; right += 1) {
        expect(placementsOverlap(result.placements[left], result.placements[right])).toBe(false);
      }
    }
  });
});
