import { expect, test } from "@playwright/test";
import type { CoreBarsPageRequest } from "../features/market/core-bars-page";
import { signInAt, terminalWebOrigin } from "./helpers/research-test-support";

const REQUEST_START = "2025-10-16T00:00:00Z";
const REQUEST_END = "2026-10-16T00:00:00Z";
const FIXTURE_AT = "2026-10-15T14:00:00Z";
const CURSOR = "synthetic-core-bars-older-1";
const PROVENANCE_ID = "synthetic-core-bars-continuation";

function pageRequest(url: URL): CoreBarsPageRequest {
  const query = url.searchParams;
  return {
    symbol: decodeURIComponent(url.pathname.slice("/api/history/".length)),
    range: query.get("range") as CoreBarsPageRequest["range"],
    resolution: query.get("resolution") as CoreBarsPageRequest["resolution"],
    asset_class: query.get("asset_class") as CoreBarsPageRequest["asset_class"],
    session_scope: query.get("session_scope") as CoreBarsPageRequest["session_scope"],
    adjustment: query.get("adjustment") as CoreBarsPageRequest["adjustment"],
    provider_mode: query.get("provider_mode") as CoreBarsPageRequest["provider_mode"],
    allow_daily_downgrade: query.get("allow_daily_downgrade") === "true",
    request_start: query.get("request_start") ?? REQUEST_START,
    request_end: query.get("request_end") ?? REQUEST_END,
    cursor: query.get("cursor"),
  };
}

function pageResponse(request: CoreBarsPageRequest, older: boolean): Record<string, unknown> {
  const rows = [13, 14].map((day, index) => {
    const start = `2026-10-${day}T00:00:00Z`;
    const end = `2026-10-${day + 1}T00:00:00Z`;
    const value = 10 + index;
    return {
      symbol: request.symbol,
      asset_class: request.asset_class,
      resolution: request.resolution,
      bar_start_utc: start,
      bar_end_exclusive_utc: end,
      received_at_utc: end,
      available_at_utc: end,
      open: value.toFixed(3),
      high: (value + 2).toFixed(3),
      low: (value - 1).toFixed(3),
      close: (value + 1).toFixed(3),
      volume: `${100 + index * 20}.00`,
      provenance_id: PROVENANCE_ID,
      session_instance_id: "synthetic-session-1",
      validation_state: "validated",
      adjustment: request.adjustment,
    };
  });
  return {
    schema_version: 1,
    provider: older ? "synthetic-e2e" : "unknown",
    feed: older ? "synthetic-e2e" : "unknown",
    entitlement_status: "unknown",
    requested_resolution: request.resolution,
    effective_resolution: request.resolution,
    rows: older ? rows : [],
    coverage_status: older ? "complete" : "unknown",
    segments: older
      ? [
          {
            start_utc: "2026-10-13T00:00:00Z",
            end_exclusive_utc: "2026-10-15T00:00:00Z",
            coverage_status: "complete",
            provenance_id: PROVENANCE_ID,
            session_instance_id: "synthetic-session-1",
          },
        ]
      : [],
    gaps: older
      ? []
      : [
          {
            start_utc: "2026-10-15T00:00:00Z",
            end_exclusive_utc: REQUEST_END,
            reason_code: "provider_unavailable",
          },
        ],
    source_provenance: older
      ? [
          {
            provenance_id: PROVENANCE_ID,
            provider: "synthetic-e2e",
            feed: "synthetic-e2e",
            entitlement_status: "unknown",
            numeric_encoding: "decimal_token",
            source: "synthetic-core-bars-continuation-e2e",
          },
        ]
      : [],
    as_of: FIXTURE_AT,
    fetched_at: FIXTURE_AT,
    cache_status: "miss",
    ...(older ? {} : { continuation_cursor: CURSOR }),
    truncated: !older,
    adjustment: request.adjustment,
  };
}

test("@component synthetic Core Bars continuation renders older rows without erasing unknown coverage", async ({
  page,
}) => {
  const origin = terminalWebOrigin();
  const servedRequests: CoreBarsPageRequest[] = [];
  const externalBrowserRequests: string[] = [];
  const allowedOrigins = new Set([origin, "http://native-mock-oidc:4450"]);
  const budgetTime = new Date();
  await page.clock.setFixedTime(budgetTime);

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!allowedOrigins.has(url.origin)) externalBrowserRequests.push(url.origin);
  });

  await signInAt(page, origin, "writer", "/");
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  const workspaceSelector = page.getByTestId("workspace-selector");
  await expect(workspaceSelector.locator("option").first()).toBeAttached();
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );
  const previousWorkspaceId = await workspaceSelector.inputValue();
  const previousWorkspaceIds = await workspaceSelector
    .locator("option")
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  let createdWorkspaceId: string | null = null;

  try {
    const oldWorkspaceCount = await workspaceSelector.locator("option").count();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await expect(workspaceSelector.locator("option")).toHaveCount(oldWorkspaceCount + 1);
    createdWorkspaceId = await workspaceSelector.inputValue();
    expect(createdWorkspaceId).not.toBe(previousWorkspaceId);
    await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
      "All changes saved",
    );

    // This same-origin route returns a synthetic BFF envelope in the browser; the real BFF,
    // MDP authentication, and market providers are outside the scope of this client regression.
    await page.route(
      (url) =>
        url.origin === origin && /^\/api\/history\/[A-Z][A-Z0-9.-]{0,11}$/u.test(url.pathname),
      async (route) => {
        const request = pageRequest(new URL(route.request().url()));
        servedRequests.push(request);
        const older = request.cursor !== null;
        await route.fulfill({
          status: older ? 200 : 206,
          json: {
            kind: "eqoboard.core-bars-page.v1",
            request,
            response: pageResponse(request, older),
          },
        });
      },
    );

    await page.getByRole("button", { name: "Add widget", exact: true }).click();
    const initialRead = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        /^\/api\/history\/[A-Z][A-Z0-9.-]{0,11}$/u.test(url.pathname) &&
        url.searchParams.get("cursor") === null
      );
    });
    await page.getByRole("menuitem", { name: /^Chart\b/u }).click();
    expect((await initialRead).status()).toBe(206);

    const chart = page.getByTestId("native-chart");
    await expect(chart).toBeVisible();
    const evidence = chart.getByTestId("native-chart-provenance");
    // waitForResponse resolves at headers; wait for the widget to decode and commit the
    // empty first page before interacting with it. Maximize re-parents the widget and
    // remounts it, which would cancel an in-flight first read and issue another head read.
    await expect(evidence).toHaveAttribute("data-chart-completeness", "unknown");
    await expect(evidence).toContainText(
      "1 gaps across 1 validated page snapshots; 0 distinct rows loaded",
    );
    await expect(chart.getByTestId("native-chart-crosshair")).toContainText(
      "0 validated historical rows loaded.",
    );
    const loadOlder = chart.getByTestId("native-chart-load-older");
    await expect(loadOlder).toBeEnabled();

    // The head and explicit cursor read share the unchanged host rate budget.
    // Verify the rejection, then advance only the synthetic browser clock by
    // the displayed retry delay; never retry or weaken a failed transport read.
    await loadOlder.click();
    const retryNotice = chart.getByRole("alert");
    await expect(retryNotice).toContainText("Older history is rate limited.");
    expect(servedRequests).toHaveLength(1);
    const retryDelay = (await retryNotice.innerText()).match(/Try again in (\d+) seconds\./u);
    expect(retryDelay).not.toBeNull();
    if (!retryDelay) throw new Error("Expected the host budget retry delay.");
    await page.clock.setFixedTime(
      new Date(budgetTime.getTime() + Number(retryDelay[1]) * 1_000),
    );

    const olderRead = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        /^\/api\/history\/[A-Z][A-Z0-9.-]{0,11}$/u.test(url.pathname) &&
        url.searchParams.get("cursor") === CURSOR
      );
    });
    await loadOlder.click();
    expect((await olderRead).status()).toBe(200);
    await expect(chart.getByTestId("native-chart-crosshair")).toContainText(
      "2 validated historical rows loaded",
    );
    await expect(evidence).toHaveAttribute("data-chart-completeness", "unknown");
    await expect(evidence).toContainText(
      "mixed; 1 segments and 1 gaps across 2 validated page snapshots; 2 distinct rows loaded",
    );
    await expect(evidence).toContainText("synthetic-core-bars-continuation-e2e");

    const canvasSizes = await chart.locator("canvas").evaluateAll((canvases) =>
      canvases.map((canvas) => ({
        width: (canvas as HTMLCanvasElement).width,
        height: (canvas as HTMLCanvasElement).height,
      })),
    );
    expect(canvasSizes.some(({ width, height }) => width > 0 && height > 0)).toBe(true);
    await expect(chart.getByTestId("native-chart-load-older")).toHaveCount(0);

    expect(externalBrowserRequests).toEqual([]);
    expect(servedRequests).toHaveLength(2);
    const head = servedRequests[0];
    const continuation = servedRequests[1];
    expect(head).toBeDefined();
    expect(continuation).toBeDefined();
    if (!head || !continuation) throw new Error("Expected a head and a continuation request.");
    expect(head.cursor).toBeNull();
    expect(continuation).toEqual({ ...head, cursor: CURSOR });
  } finally {
    const currentWorkspaceId = await workspaceSelector.inputValue().catch(() => null);
    const ownedWorkspaceId =
      createdWorkspaceId ??
      (currentWorkspaceId && !previousWorkspaceIds.includes(currentWorkspaceId)
        ? currentWorkspaceId
        : null);
    if (ownedWorkspaceId) {
      await workspaceSelector.selectOption(ownedWorkspaceId);
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Delete workspace", exact: true }).click();
      await expect(workspaceSelector.locator("option")).toHaveCount(previousWorkspaceIds.length);
      await workspaceSelector.selectOption(previousWorkspaceId);
      await expect(workspaceSelector).toHaveValue(previousWorkspaceId);
      await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
        "All changes saved",
      );
    }
  }
});
