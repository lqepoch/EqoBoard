import { createHash } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  YFINANCE_RESEARCH_MAX_PAGE_DAYS,
  YFINANCE_RESEARCH_MAX_PAGES,
} from "../features/research/yfinance-contract";
import {
  YFINANCE_DAILY_QUERY,
  readGatewayFixtureCounters,
  readMdpFixtureCounters,
  researchWebOrigin,
  resetGatewayFixtureCounters,
  resetMdpFixtureCounters,
  signInAt,
  terminalWebOrigin,
} from "./helpers/research-test-support";

const MDP_RESEARCH_ROUTE = "/v1/research/yfinance/daily";
const SECRET_SENTINEL_PREFIX = "NATIVE_SERVER_ONLY_SECRET_SENTINEL_20261015_";

function candidateSha(): string {
  const sha = process.env.E2E_CANDIDATE_SHA;
  if (!sha || !/^[0-9a-f]{40}$/iu.test(sha)) {
    throw new Error(
      "E2E_CANDIDATE_SHA must be the frozen native source-head SHA supplied by the Compose helper.",
    );
  }
  return sha.toLowerCase();
}

async function attachResearchChartCandidateSample(
  page: Page,
  testInfo: TestInfo,
  chartReadyMs: number,
  apiBodyBytes: number,
  fixtureResponseSha256: string,
) {
  const navigationMetrics = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      responseStartMs: entry?.responseStart ?? null,
      domContentLoadedMs: entry?.domContentLoadedEventEnd ?? null,
      transferBytes: entry?.transferSize ?? null,
      encodedBodyBytes: entry?.encodedBodySize ?? null,
      decodedBodyBytes: entry?.decodedBodySize ?? null,
    };
  });
  await testInfo.attach("yahoo-research-candidate-sample", {
    body: JSON.stringify(
      {
        evidenceStatus: "candidate-sample-only; paired-legacy-baseline-not-run",
        candidateSha: candidateSha(),
        origin: new URL(page.url()).origin,
        browserVersion: page.context().browser()?.version() ?? null,
        chartReadyMs,
        firstValidatedApiResponseBytes: apiBodyBytes,
        fixtureResponseSha256,
        fixtureLabel: "native-e2e synthetic fixture; not provider data",
        ...navigationMetrics,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
}

type YfinanceObservation = Readonly<{
  schema_version: string;
  provider: string;
  source: string;
  canonical: boolean;
  point_in_time: boolean;
  executable: boolean;
  display_only: boolean;
  mdp_coverage_asserted: boolean;
  observation: Readonly<{
    source_observation_sha256: string;
    payload: Readonly<{
      schema_version: string;
      source: string;
      provider_adjustment_semantics: string;
      adjustment_confirmed_raw: boolean;
      canonical: boolean;
      point_in_time: boolean;
      executable: boolean;
      display_only: boolean;
      coverage: Readonly<{ calendar_gaps_assessed: boolean }>;
      provenance: Readonly<{ adapter_version: string }>;
      bars: readonly Readonly<{ event_ts_utc: string }>[];
    }>;
  }>;
}>;

type PagedYfinanceObservation = YfinanceObservation &
  Readonly<{
    requested_range: Readonly<{ start_utc: string; end_utc: string; semantics: string }>;
    page_range: Readonly<{ start_utc: string; end_utc: string; semantics: string }>;
    next_cursor: string | null;
  }>;

test("@api Yahoo history is isolated to the signed research mode and fails before MDP on authz errors", async ({
  browser,
  page,
  request,
}) => {
  const terminalOrigin = terminalWebOrigin();
  const researchOrigin = researchWebOrigin();
  const yahooPath = `/api/research/yfinance/daily?${YFINANCE_DAILY_QUERY}`;
  await resetGatewayFixtureCounters(request);
  await resetMdpFixtureCounters(request);

  const terminalResponse = await page.request.get(new URL(yahooPath, terminalOrigin).toString(), {
    headers: { Accept: "application/json" },
  });
  expect(terminalResponse.status()).toBe(404);
  expect(terminalResponse.headers()["cache-control"]).toMatch(/no-store/u);
  expect(JSON.stringify(await terminalResponse.json())).not.toContain(SECRET_SENTINEL_PREFIX);
  expect((await readMdpFixtureCounters(request)).calls[MDP_RESEARCH_ROUTE] ?? 0).toBe(0);

  const anonymousResearch = await page.request.get(new URL(yahooPath, researchOrigin).toString(), {
    headers: { Accept: "application/json" },
  });
  expect(anonymousResearch.status()).toBe(401);
  expect(anonymousResearch.headers()["cache-control"]).toMatch(/no-store/u);
  expect(await anonymousResearch.json()).toEqual({ error: "unauthenticated" });
  expect((await readMdpFixtureCounters(request)).calls[MDP_RESEARCH_ROUTE] ?? 0).toBe(0);

  const researchReaderContext = await browser.newContext();
  const researchReaderPage = await researchReaderContext.newPage();
  try {
    await signInAt(researchReaderPage, researchOrigin, "reader", "/");
    const terminalOnlyPaths = [
      "/api/quotes?symbols=SPY",
      "/api/status",
      "/api/eqo/live",
      "/api/eqo/orders/preview",
      "/api/eqo/engine/status",
      "/api/workspaces",
    ];
    for (const path of terminalOnlyPaths) {
      const response = await researchReaderPage.request.fetch(
        new URL(path, researchOrigin).toString(),
        {
          method: path.endsWith("/preview") ? "POST" : "GET",
          ...(path.endsWith("/preview")
            ? { headers: { "Content-Type": "application/json", Origin: researchOrigin }, data: {} }
            : {}),
        },
      );
      expect(response.status(), path).toBe(404);
      expect(await response.json(), path).toEqual({ error: "not_found" });
    }
    const dispatches = await readGatewayFixtureCounters(request);
    for (const path of [
      "/api/v1/stocks/snapshots",
      "/api/v1/status",
      "/api/v1/stream/sse",
      "/api/v1/orders/preview",
    ]) {
      expect(
        dispatches.calls[path] ?? 0,
        `Research runtime must not dispatch terminal route ${path}`,
      ).toBe(0);
    }
    expect((await readMdpFixtureCounters(request)).calls[MDP_RESEARCH_ROUTE] ?? 0).toBe(0);
  } finally {
    await researchReaderContext.close();
  }

  const workspaceOnlyContext = await browser.newContext();
  const workspaceOnlyPage = await workspaceOnlyContext.newPage();
  try {
    // The route-level assertion deliberately signs in at the shared shell so
    // it remains independent of the separately accepted Research chart page.
    await signInAt(workspaceOnlyPage, researchOrigin, "workspace-only", "/", "policy-rejected");
    const forbidden = await workspaceOnlyPage.request.get(
      new URL(yahooPath, researchOrigin).toString(),
      {
        headers: { Accept: "application/json" },
      },
    );
    expect(forbidden.status()).toBe(403);
    expect(forbidden.headers()["cache-control"]).toMatch(/no-store/u);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
    expect((await readMdpFixtureCounters(request)).calls[MDP_RESEARCH_ROUTE] ?? 0).toBe(0);
    const deniedCounters = await readMdpFixtureCounters(request);
    expect(deniedCounters.acceptedDelegations).toBe(0);
    expect(deniedCounters.rejectedDelegations).toBe(0);
  } finally {
    await workspaceOnlyContext.close();
  }
});

test("@api a research reader receives only the validated Yahoo observation and a research-scoped MDP delegation", async ({
  browser,
  request,
}) => {
  const researchOrigin = researchWebOrigin();
  const yahooPath = `/api/research/yfinance/daily?${YFINANCE_DAILY_QUERY}`;
  await resetMdpFixtureCounters(request);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signInAt(page, researchOrigin, "reader", "/");
    await resetMdpFixtureCounters(request);
    const response = await page.request.get(new URL(yahooPath, researchOrigin).toString(), {
      headers: { Accept: "application/json" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toMatch(/no-store/u);
    expect(response.headers()["content-type"]).toMatch(/application\/json/iu);
    const observation = (await response.json()) as YfinanceObservation;
    expect(observation).toMatchObject({
      schema_version: "mdp-yfinance-research-observations-v1",
      provider: "yfinance",
      source: "Yahoo Finance",
      canonical: false,
      point_in_time: false,
      executable: false,
      display_only: true,
      mdp_coverage_asserted: false,
      observation: {
        payload: {
          schema_version: "yfinance-history-bridge-v1",
          source: "Yahoo Finance",
          provider_adjustment_semantics: "unknown_or_provider_native",
          adjustment_confirmed_raw: false,
          canonical: false,
          point_in_time: false,
          executable: false,
          display_only: true,
          provenance: { adapter_version: expect.stringContaining("bounded-synthetic-e2e") },
        },
      },
    });
    expect(observation.observation.source_observation_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(observation.observation.payload.coverage.calendar_gaps_assessed).toBe(false);
    expect(JSON.stringify(observation)).not.toContain(SECRET_SENTINEL_PREFIX);

    const counters = await readMdpFixtureCounters(request);
    expect(counters.calls[MDP_RESEARCH_ROUTE]).toBe(1);
    expect(counters.acceptedDelegations).toBe(1);
    expect(counters.rejectedDelegations).toBe(0);
    expect(counters.fixture).toContain("synthetic fixture");
  } finally {
    await context.close();
  }
});

test("@component Yahoo Research chart stays display-only, source-labelled, and explicitly paginated", async ({
  browser,
  page,
  request,
}, testInfo) => {
  const researchOrigin = researchWebOrigin();
  const researchPath = "/research/yfinance/SPY";

  await resetMdpFixtureCounters(request);
  await page.goto(new URL(researchPath, researchOrigin).toString(), { waitUntil: "networkidle" });
  await expect(page.getByTestId("yahoo-research-page")).toBeVisible();
  await expect(
    page.getByText("Sign in with research:read to load Yahoo daily observations."),
  ).toBeVisible();
  await expect(page.getByTestId("yahoo-research-chart")).toHaveCount(0);
  expect((await readMdpFixtureCounters(request)).calls[MDP_RESEARCH_ROUTE] ?? 0).toBe(0);

  const context = await browser.newContext();
  const researchPage = await context.newPage();
  const browserRequests: string[] = [];
  try {
    await signInAt(researchPage, researchOrigin, "reader", "/");
    await resetMdpFixtureCounters(request);
    researchPage.on("request", (browserRequest) => browserRequests.push(browserRequest.url()));

    const chartStartedAt = Date.now();
    const initialRead = researchPage.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/research/yfinance/daily",
    );
    await researchPage.goto(new URL(researchPath, researchOrigin).toString(), {
      waitUntil: "domcontentloaded",
    });
    const initialResponse = await initialRead;
    expect(initialResponse.status()).toBe(200);
    const firstApiBody = await initialResponse.body();
    const firstApiBodyBytes = firstApiBody.byteLength;
    const fixtureResponseSha256 = createHash("sha256").update(firstApiBody).digest("hex");

    const chart = researchPage.getByTestId("yahoo-research-chart");
    const evidence = chart.getByTestId("native-chart-provenance");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-history-status", "ready");
    await expect(researchPage.getByTestId("yahoo-indicator-sma20")).toBeChecked();
    await expect(evidence).toHaveAttribute("data-chart-mode", "yahoo-daily");
    await expect(evidence).toContainText("Yahoo Finance");
    await expect(evidence).toContainText("yfinance");
    await expect(evidence).toContainText("provider-float");
    await expect(evidence).toContainText("MDP coverage not asserted");
    await expect(evidence).toContainText("Display only · non-canonical · non-PIT · non-executable");
    await expect(evidence).toContainText("Synthetic acceptance fixture · bounded-synthetic-e2e");
    await expect(chart.getByTestId("native-chart-surface")).toHaveAttribute(
      "data-chart-live",
      "false",
    );
    await expect(chart).toContainText("provider adjustment semantics are unconfirmed");
    await expect(researchPage.getByTestId("native-chart-tradingview-attribution")).toContainText(
      "TradingView Lightweight Charts",
    );
    await expect(chart.getByTestId("native-chart-crosshair")).toContainText("25 loaded bars");
    const chartReadyMs = Date.now() - chartStartedAt;
    await expect(researchPage.locator("body")).not.toContainText(
      /PAPER_READY|FILLED|simulator-fallback/iu,
    );
    expect((await readMdpFixtureCounters(request)).calls[MDP_RESEARCH_ROUTE]).toBe(1);
    await attachResearchChartCandidateSample(
      researchPage,
      testInfo,
      chartReadyMs,
      firstApiBodyBytes,
      fixtureResponseSha256,
    );

    // Indicator changes are local display projections; widening the requested window is an explicit read.
    await researchPage.getByTestId("yahoo-indicator-sma20").uncheck();
    await researchPage.getByTestId("yahoo-indicator-sma20").check();
    const expectedMaxEnd = new Date();
    expectedMaxEnd.setUTCHours(0, 0, 0, 0);
    const supportedStartUtc = "1970-01-01T00:00:00.000Z";
    const expectedMaxEndUtc = expectedMaxEnd.toISOString();
    const maxRangeReadPromise = researchPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/research/yfinance/daily" &&
        url.searchParams.get("cursor") === null &&
        url.searchParams.get("symbols") === "SPY" &&
        url.searchParams.get("asset_class") === "stock" &&
        url.searchParams.get("adjustment") === "unadjusted" &&
        url.searchParams.get("start_utc") === supportedStartUtc &&
        url.searchParams.get("end_utc") === expectedMaxEndUtc
      );
    });
    await researchPage.getByLabel("Daily window").selectOption("MAX");
    const maxRangeRead = await maxRangeReadPromise;
    expect(maxRangeRead.status()).toBe(200);
    expect(await maxRangeRead.finished()).toBeNull();
    const maxRangeBody = await maxRangeRead.body();
    const maxRange = JSON.parse(maxRangeBody.toString("utf8")) as PagedYfinanceObservation;
    expect(maxRange.requested_range).toEqual({
      start_utc: supportedStartUtc,
      end_utc: expectedMaxEndUtc,
      semantics: "start_inclusive_end_exclusive",
    });
    const maxStartMs = Date.parse(maxRange.requested_range.start_utc);
    const maxEndMs = Date.parse(maxRange.requested_range.end_utc);
    const pageDurationMs = YFINANCE_RESEARCH_MAX_PAGE_DAYS * 86_400_000;
    const expectedPageCount = Math.ceil((maxEndMs - maxStartMs) / pageDurationMs);
    expect(expectedPageCount).toBeGreaterThan(0);
    expect(expectedPageCount).toBeLessThanOrEqual(YFINANCE_RESEARCH_MAX_PAGES);
    expect(maxRange.page_range).toEqual({
      start_utc: new Date(Math.max(maxStartMs, maxEndMs - pageDurationMs)).toISOString(),
      end_utc: maxRange.requested_range.end_utc,
      semantics: "start_inclusive_end_exclusive",
    });
    expect(maxRange.next_cursor).toBe(expectedPageCount > 1 ? "older:1" : null);
    expect(maxRange).toMatchObject({
      source: "Yahoo Finance",
      provider: "yfinance",
      canonical: false,
      point_in_time: false,
      executable: false,
      display_only: true,
      mdp_coverage_asserted: false,
      observation: {
        payload: {
          provenance: { adapter_version: expect.stringContaining("bounded-synthetic-e2e") },
        },
      },
    });
    expect(maxRange.observation.payload.bars).toHaveLength(25);

    const olderPageButton = chart.getByTestId("yahoo-research-load-older");
    if (expectedPageCount > 1) await expect(olderPageButton).toBeVisible();
    let previousPage = maxRange;
    for (let pageNumber = 2; pageNumber <= expectedPageCount; pageNumber += 1) {
      const cursor = previousPage.next_cursor;
      expect(cursor).toBe(`older:${pageNumber - 1}`);
      const olderRead = researchPage.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/research/yfinance/daily" &&
          url.searchParams.get("cursor") === cursor
        );
      });
      await olderPageButton.click();
      const olderResponse = await olderRead;
      expect(olderResponse.status(), `Research page ${pageNumber}`).toBe(200);
      const olderPage = (await olderResponse.json()) as PagedYfinanceObservation;
      const expectedPageEnd = Date.parse(previousPage.page_range.start_utc);
      const expectedPageStart = Math.max(maxStartMs, expectedPageEnd - pageDurationMs);
      expect(olderPage.requested_range).toEqual(maxRange.requested_range);
      expect(olderPage.page_range).toEqual({
        start_utc: new Date(expectedPageStart).toISOString(),
        end_utc: new Date(expectedPageEnd).toISOString(),
        semantics: "start_inclusive_end_exclusive",
      });
      expect(olderPage.next_cursor).toBe(
        pageNumber < expectedPageCount ? `older:${pageNumber}` : null,
      );
      expect(olderPage).toMatchObject({
        source: "Yahoo Finance",
        provider: "yfinance",
        canonical: false,
        point_in_time: false,
        executable: false,
        display_only: true,
        mdp_coverage_asserted: false,
        observation: {
          payload: {
            provenance: { adapter_version: expect.stringContaining("bounded-synthetic-e2e") },
          },
        },
      });
      expect(olderPage.observation.payload.bars).toHaveLength(25);
      previousPage = olderPage;
      if (pageNumber < expectedPageCount) await expect(olderPageButton).toBeEnabled();
    }

    await expect(olderPageButton).toHaveCount(0);
    await expect(evidence).toContainText(`${expectedPageCount} page(s)`);
    const counters = await readMdpFixtureCounters(request);
    expect(counters.calls[MDP_RESEARCH_ROUTE]).toBe(1 + expectedPageCount);
    expect(counters.acceptedDelegations).toBe(1 + expectedPageCount);
    expect(counters.rejectedDelegations).toBe(0);
    expect(counters.fixture).toBe("native-e2e synthetic fixture; not provider data");

    const externalProviderRequests = browserRequests.filter((rawUrl) =>
      /(?:^|\.)yahoo(?:apis)?\.|finance\.yahoo|futu|alpaca|interactivebrokers|schwab/iu.test(
        new URL(rawUrl).hostname,
      ),
    );
    expect(externalProviderRequests).toEqual([]);
    expect(browserRequests.filter((rawUrl) => new URL(rawUrl).origin !== researchOrigin)).toEqual(
      [],
    );
    const terminalMarketRequests = browserRequests.filter((rawUrl) =>
      ["/api/eqo/live", "/api/eqo/stocks/subscribe", "/api/eqo/options/subscribe"].includes(
        new URL(rawUrl).pathname,
      ),
    );
    expect(terminalMarketRequests).toEqual([]);
    const serializedClientState = await researchPage.evaluate(() =>
      JSON.stringify({
        markup: document.documentElement.outerHTML,
        localStorage: Object.entries(localStorage),
        sessionStorage: Object.entries(sessionStorage),
        cookies: document.cookie,
      }),
    );
    expect(serializedClientState).not.toContain(SECRET_SENTINEL_PREFIX);
    expect(serializedClientState).not.toMatch(
      /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/u,
    );
  } finally {
    await context.close();
  }
});

test("@api Yahoo pagination preserves adjacent page bounds, explicit cursors, and source flags", async ({
  browser,
  request,
}) => {
  const researchOrigin = researchWebOrigin();
  const query = new URLSearchParams({
    symbols: "SPY",
    asset_class: "stock",
    start_utc: "2000-01-01T00:00:00.000Z",
    end_utc: "2026-01-01T00:00:00.000Z",
    adjustment: "adjusted",
  });
  const firstPageUrl = new URL(
    `/api/research/yfinance/daily?${query.toString()}`,
    researchOrigin,
  ).toString();
  await resetMdpFixtureCounters(request);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signInAt(page, researchOrigin, "reader", "/");
    await resetMdpFixtureCounters(request);
    const firstResponse = await page.request.get(firstPageUrl, {
      headers: { Accept: "application/json" },
    });
    expect(firstResponse.status()).toBe(200);
    const first = (await firstResponse.json()) as PagedYfinanceObservation;
    expect(first.next_cursor).toBe("older:1");
    if (first.next_cursor === null)
      throw new Error("The first page must expose an explicit older cursor for this range.");
    expect(first.page_range.semantics).toBe("start_inclusive_end_exclusive");
    expect(first.page_range.end_utc).toBe(first.requested_range.end_utc);

    const secondUrl = new URL(firstPageUrl);
    secondUrl.searchParams.set("cursor", first.next_cursor);
    const secondResponse = await page.request.get(secondUrl.toString(), {
      headers: { Accept: "application/json" },
    });
    expect(secondResponse.status()).toBe(200);
    const second = (await secondResponse.json()) as PagedYfinanceObservation;
    expect(second.requested_range).toEqual(first.requested_range);
    expect(second.page_range.end_utc).toBe(first.page_range.start_utc);
    expect(second.next_cursor).toBe("older:2");
    if (second.next_cursor === null)
      throw new Error("The second page must expose an explicit older cursor for this range.");

    const thirdUrl = new URL(firstPageUrl);
    thirdUrl.searchParams.set("cursor", second.next_cursor);
    const thirdResponse = await page.request.get(thirdUrl.toString(), {
      headers: { Accept: "application/json" },
    });
    expect(thirdResponse.status()).toBe(200);
    const third = (await thirdResponse.json()) as PagedYfinanceObservation;
    expect(third.requested_range).toEqual(first.requested_range);
    expect(third.page_range.end_utc).toBe(second.page_range.start_utc);
    expect(third.page_range.start_utc).toBe(first.requested_range.start_utc);
    expect(third.next_cursor).toBeNull();

    for (const observation of [first, second, third]) {
      expect(observation).toMatchObject({
        source: "Yahoo Finance",
        canonical: false,
        point_in_time: false,
        executable: false,
        display_only: true,
        mdp_coverage_asserted: false,
      });
      expect(observation.observation.payload.coverage.calendar_gaps_assessed).toBe(false);
      expect(observation.observation.payload.provenance.adapter_version).toContain(
        "bounded-synthetic-e2e",
      );
      for (const bar of observation.observation.payload.bars) {
        expect(Date.parse(bar.event_ts_utc)).toBeGreaterThanOrEqual(
          Date.parse(observation.page_range.start_utc),
        );
        expect(Date.parse(bar.event_ts_utc)).toBeLessThan(
          Date.parse(observation.page_range.end_utc),
        );
      }
    }

    const counters = await readMdpFixtureCounters(request);
    expect(counters.calls[MDP_RESEARCH_ROUTE]).toBe(3);
    expect(counters.acceptedDelegations).toBe(3);
    expect(counters.rejectedDelegations).toBe(0);
  } finally {
    await context.close();
  }
});

test("@api terminal and research OIDC sessions stay isolated across the two approved hostnames", async ({
  browser,
}) => {
  const terminalOrigin = terminalWebOrigin();
  const researchOrigin = researchWebOrigin();
  const yahooUrl = new URL(
    `/api/research/yfinance/daily?${YFINANCE_DAILY_QUERY}`,
    researchOrigin,
  ).toString();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signInAt(page, terminalOrigin, "reader", "/");

    // A valid terminal session cannot authenticate the research-only hostname.
    const researchBeforeSignIn = await page.request.get(yahooUrl, {
      headers: { Accept: "application/json" },
    });
    expect(researchBeforeSignIn.status()).toBe(401);
    expect(await researchBeforeSignIn.json()).toEqual({ error: "unauthenticated" });

    await signInAt(page, researchOrigin, "reader", "/");
    const researchSignedIn = await page.request.get(yahooUrl, {
      headers: { Accept: "application/json" },
    });
    expect(researchSignedIn.status()).toBe(200);

    const researchClientState = await page.evaluate(() => ({
      markup: document.documentElement.outerHTML,
      url: location.href,
      localStorage: Object.entries(localStorage),
      sessionStorage: Object.entries(sessionStorage),
      visibleCookies: document.cookie,
    }));
    const serializedResearchClientState = JSON.stringify(researchClientState);
    expect(serializedResearchClientState).not.toContain(SECRET_SENTINEL_PREFIX);
    expect(serializedResearchClientState).not.toMatch(
      /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/u,
    );
    expect(serializedResearchClientState).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|broker[_-]?key/iu,
    );
    expect(serializedResearchClientState).not.toContain("native-e2e-reader");
    expect(serializedResearchClientState).not.toContain("eqoboard-market-reader");

    const researchScripts = await page
      .locator("script[src]")
      .evaluateAll((scripts) =>
        scripts
          .map((script) => (script as HTMLScriptElement).src)
          .filter((url) => new URL(url).origin === location.origin),
      );
    for (const scriptUrl of researchScripts) {
      const script = await page.request.get(scriptUrl);
      expect(script.ok()).toBe(true);
      expect(await script.text()).not.toContain(SECRET_SENTINEL_PREFIX);
    }

    const browserCookies = await context.cookies([terminalOrigin, researchOrigin]);
    expect(browserCookies.some((cookie) => cookie.value.includes(SECRET_SENTINEL_PREFIX))).toBe(
      false,
    );
    const safeSessionCookieMetadata = browserCookies
      .filter((cookie) => cookie.name.endsWith(".session-token"))
      .map(({ name, domain, httpOnly, secure }) => ({
        name,
        domain: domain.replace(/^\./u, ""),
        httpOnly,
        secure,
      }));
    expect(safeSessionCookieMetadata).toEqual(
      expect.arrayContaining([
        { name: "eqoboard.session-token", domain: "127.0.0.1", httpOnly: true, secure: false },
        {
          name: "eqoboard-research.session-token",
          domain: "localhost",
          httpOnly: true,
          secure: false,
        },
      ]),
    );

    await page.getByTestId("account-menu").locator("summary").click();
    await page.getByTestId("account-menu").getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByTestId("access-state")).toContainText("Sign in to open your workspace");

    const researchAfterSignOut = await page.request.get(yahooUrl, {
      headers: { Accept: "application/json" },
    });
    expect(researchAfterSignOut.status()).toBe(401);

    const terminalStillSignedIn = await page.request.get(
      new URL("/api/quotes?symbols=SPY", terminalOrigin).toString(),
      {
        headers: { Accept: "application/json" },
      },
    );
    expect(terminalStillSignedIn.status()).toBe(200);
    expect(JSON.stringify(safeSessionCookieMetadata)).not.toContain(SECRET_SENTINEL_PREFIX);
  } finally {
    await context.close();
  }
});
