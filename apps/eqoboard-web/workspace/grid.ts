import type { WidgetRegistry } from "../widgets/registry/types";
import { WORKSPACE_LIMITS, type GridPlacementV1, type WorkspaceTabV1 } from "./model";

export type GridSizeConstraints = Readonly<{
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}>;

export type GridMutationResult =
  | Readonly<{ ok: true; placements: GridPlacementV1[] }>
  | Readonly<{ ok: false; reason: "unknown-item" | "invalid-size" | "grid-full" }>;

const DEFAULT_CONSTRAINTS: GridSizeConstraints = {
  minW: 1,
  minH: 1,
  maxW: WORKSPACE_LIMITS.gridColumns,
  maxH: WORKSPACE_LIMITS.gridMaxRows,
};

export function constraintsForManifest(
  registry: WidgetRegistry,
  manifestId: string,
): GridSizeConstraints {
  const registration = registry.get(manifestId);
  if (!registration) return DEFAULT_CONSTRAINTS;
  const size = registration.manifest.defaultSize;
  return {
    minW: size.minW,
    minH: size.minH,
    maxW: Math.min(size.maxW, WORKSPACE_LIMITS.gridColumns),
    maxH: Math.min(size.maxH, WORKSPACE_LIMITS.gridMaxRows),
  };
}

export function placementsOverlap(a: GridPlacementV1, b: GridPlacementV1): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function isWithinBounds(item: GridPlacementV1, size: GridSizeConstraints): boolean {
  return Number.isSafeInteger(item.x) && Number.isSafeInteger(item.y) &&
    Number.isSafeInteger(item.w) && Number.isSafeInteger(item.h) &&
    item.x >= 0 && item.y >= 0 && item.w >= size.minW && item.h >= size.minH &&
    item.w <= size.maxW && item.h <= size.maxH &&
    item.x + item.w <= WORKSPACE_LIMITS.gridColumns &&
    item.y + item.h <= WORKSPACE_LIMITS.gridMaxRows;
}

function clampSize(item: GridPlacementV1, size: GridSizeConstraints): GridPlacementV1 {
  const w = Math.max(size.minW, Math.min(size.maxW, item.w));
  const h = Math.max(size.minH, Math.min(size.maxH, item.h));
  return {
    ...item,
    x: Math.max(0, Math.min(WORKSPACE_LIMITS.gridColumns - w, item.x)),
    y: Math.max(0, Math.min(WORKSPACE_LIMITS.gridMaxRows - h, item.y)),
    w,
    h,
  };
}

/**
 * Resolve a pointer/keyboard move by preserving the moved widget's requested
 * cell and pushing collisions down in stable top-left order.
 */
export function moveGridItem(
  placements: readonly GridPlacementV1[],
  instanceId: string,
  requested: Pick<GridPlacementV1, "x" | "y">,
): GridMutationResult {
  const source = placements.find((item) => item.i === instanceId);
  if (!source) return { ok: false, reason: "unknown-item" };
  const rest = placements.filter((item) => item.i !== instanceId).map((item) => ({ ...item }));
  let anchor: GridPlacementV1 = {
    ...source,
    x: Math.max(0, Math.min(WORKSPACE_LIMITS.gridColumns - source.w, Math.round(requested.x))),
    y: Math.max(0, Math.min(WORKSPACE_LIMITS.gridMaxRows - source.h, Math.round(requested.y))),
  };
  const queue = [anchor];
  let pushes = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const collided = rest
      .filter((item) => placementsOverlap(current, item))
      .sort((a, b) => a.y - b.y || a.x - b.x || a.i.localeCompare(b.i));
    for (const item of collided) {
      const index = rest.findIndex((candidate) => candidate.i === item.i);
      const pushed = { ...item, y: current.y + current.h };
      if (pushed.y + pushed.h > WORKSPACE_LIMITS.gridMaxRows) return { ok: false, reason: "grid-full" };
      rest[index] = pushed;
      queue.push(pushed);
      pushes += 1;
      if (pushes > placements.length * placements.length) return { ok: false, reason: "grid-full" };
    }
  }
  anchor = { ...anchor };
  return { ok: true, placements: [...rest, anchor].sort(byPosition) };
}

/** Resize keeps the upper-left anchor and pushes any collided widgets down. */
export function resizeGridItem(
  placements: readonly GridPlacementV1[],
  instanceId: string,
  requested: Pick<GridPlacementV1, "w" | "h">,
  constraints: GridSizeConstraints = DEFAULT_CONSTRAINTS,
): GridMutationResult {
  const source = placements.find((item) => item.i === instanceId);
  if (!source) return { ok: false, reason: "unknown-item" };
  const next = clampSize({ ...source, ...requested }, constraints);
  if (!isWithinBounds(next, constraints)) return { ok: false, reason: "invalid-size" };
  const withSize = placements.map((item) => item.i === instanceId ? next : { ...item });
  return moveGridItem(withSize, instanceId, { x: next.x, y: next.y });
}

export function findNextFreePlacement(
  placements: readonly GridPlacementV1[],
  instanceId: string,
  preferredSize: Pick<GridPlacementV1, "w" | "h">,
  constraints: GridSizeConstraints = DEFAULT_CONSTRAINTS,
): GridPlacementV1 | null {
  const w = Math.max(constraints.minW, Math.min(constraints.maxW, preferredSize.w));
  const h = Math.max(constraints.minH, Math.min(constraints.maxH, preferredSize.h));
  for (let y = 0; y + h <= WORKSPACE_LIMITS.gridMaxRows; y += 1) {
    for (let x = 0; x + w <= WORKSPACE_LIMITS.gridColumns; x += 1) {
      const candidate = { i: instanceId, x, y, w, h };
      if (placements.every((item) => !placementsOverlap(candidate, item))) return candidate;
    }
  }
  return null;
}

/** Clamp an RGL callback into the stable persisted v1 layout shape. */
export function fromGridCallback(
  proposed: readonly Readonly<{ i: string; x: number; y: number; w: number; h: number }>[],
  tab: WorkspaceTabV1,
  registry: WidgetRegistry,
): GridMutationResult {
  const widgetById = new Map(tab.widgets.map((widget) => [widget.instanceId, widget]));
  if (proposed.length !== tab.widgets.length || proposed.some((item) => !widgetById.has(item.i))) {
    return { ok: false, reason: "unknown-item" };
  }
  const normalized: GridPlacementV1[] = [];
  for (const item of proposed) {
    const widget = widgetById.get(item.i)!;
    const constraints = constraintsForManifest(registry, widget.manifestId);
    const placement = clampSize(item, constraints);
    if (!isWithinBounds(placement, constraints)) return { ok: false, reason: "invalid-size" };
    normalized.push(placement);
  }
  const ordered = [...normalized].sort(byPosition);
  const resolved: GridPlacementV1[] = [];
  for (const item of ordered) {
    let candidate = item;
    while (resolved.some((placed) => placementsOverlap(candidate, placed))) {
      candidate = { ...candidate, y: candidate.y + 1 };
      if (candidate.y + candidate.h > WORKSPACE_LIMITS.gridMaxRows) return { ok: false, reason: "grid-full" };
    }
    resolved.push(candidate);
  }
  return { ok: true, placements: resolved.sort(byPosition) };
}

export function keyboardMove(
  placements: readonly GridPlacementV1[],
  instanceId: string,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): GridMutationResult {
  const item = placements.find((candidate) => candidate.i === instanceId);
  if (!item) return { ok: false, reason: "unknown-item" };
  const delta = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }[key];
  return moveGridItem(placements, instanceId, { x: item.x + delta[0], y: item.y + delta[1] });
}

export function keyboardResize(
  placements: readonly GridPlacementV1[],
  instanceId: string,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  constraints: GridSizeConstraints,
): GridMutationResult {
  const item = placements.find((candidate) => candidate.i === instanceId);
  if (!item) return { ok: false, reason: "unknown-item" };
  const delta = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }[key];
  return resizeGridItem(placements, instanceId, { w: item.w + delta[0], h: item.h + delta[1] }, constraints);
}

export function byPosition(a: GridPlacementV1, b: GridPlacementV1): number {
  return a.y - b.y || a.x - b.x || a.i.localeCompare(b.i);
}

export function toRglLayout(placements: readonly GridPlacementV1[]): GridPlacementV1[] {
  return placements.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
}
