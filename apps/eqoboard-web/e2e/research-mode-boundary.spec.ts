import { expect, test } from "@playwright/test";
import {
  YFINANCE_DAILY_QUERY,
  readMdpFixtureCounters,
  researchWebOrigin,
  resetMdpFixtureCounters,
  signInAt,
  terminalWebOrigin,
} from "./helpers/research-test-support";

const MDP_RESEARCH_ROUTE = "/v1/research/yfinance/daily";
const SECRET_SENTINEL_PREFIX = "NATIVE_SERVER_ONLY_SECRET_SENTINEL_20261015_";

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
    }>;
  }>;
}>;

test("@api Yahoo history is isolated to the signed research mode and fails before MDP on authz errors", async ({
  browser,
  page,
  request,
}) => {
  const terminalOrigin = terminalWebOrigin();
  const researchOrigin = researchWebOrigin();
  const yahooPath = `/api/research/yfinance/daily?${YFINANCE_DAILY_QUERY}`;
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

  const workspaceOnlyContext = await browser.newContext();
  const workspaceOnlyPage = await workspaceOnlyContext.newPage();
  try {
    // The route-level assertion deliberately signs in at the shared shell so
    // it remains independent of the separately accepted Research chart page.
    await signInAt(workspaceOnlyPage, researchOrigin, "workspace-only", "/");
    const forbidden = await workspaceOnlyPage.request.get(new URL(yahooPath, researchOrigin).toString(), {
      headers: { Accept: "application/json" },
    });
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
    const observation = await response.json() as YfinanceObservation;
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

test("@api terminal and research OIDC sessions stay isolated across the two approved hostnames", async ({ browser }) => {
  const terminalOrigin = terminalWebOrigin();
  const researchOrigin = researchWebOrigin();
  const yahooUrl = new URL(`/api/research/yfinance/daily?${YFINANCE_DAILY_QUERY}`, researchOrigin).toString();
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
    expect(serializedResearchClientState).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/u);
    expect(serializedResearchClientState).not.toMatch(/access[_-]?token|refresh[_-]?token|client[_-]?secret|broker[_-]?key/iu);
    expect(serializedResearchClientState).not.toContain("native-e2e-reader");
    expect(serializedResearchClientState).not.toContain("eqoboard-market-reader");

    const researchScripts = await page.locator("script[src]").evaluateAll((scripts) =>
      scripts.map((script) => (script as HTMLScriptElement).src)
        .filter((url) => new URL(url).origin === location.origin),
    );
    for (const scriptUrl of researchScripts) {
      const script = await page.request.get(scriptUrl);
      expect(script.ok()).toBe(true);
      expect(await script.text()).not.toContain(SECRET_SENTINEL_PREFIX);
    }

    const browserCookies = await context.cookies([terminalOrigin, researchOrigin]);
    expect(browserCookies.some((cookie) => cookie.value.includes(SECRET_SENTINEL_PREFIX))).toBe(false);
    const safeSessionCookieMetadata = browserCookies
      .filter((cookie) => cookie.name.endsWith(".session-token"))
      .map(({ name, domain, httpOnly, secure }) => ({ name, domain: domain.replace(/^\./u, ""), httpOnly, secure }));
    expect(safeSessionCookieMetadata).toEqual(expect.arrayContaining([
      { name: "eqoboard.session-token", domain: "127.0.0.1", httpOnly: true, secure: false },
      { name: "eqoboard-research.session-token", domain: "localhost", httpOnly: true, secure: false },
    ]));

    await page.getByTestId("account-menu").locator("summary").click();
    await page.getByTestId("account-menu").getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByTestId("access-state")).toContainText("Sign in to open your workspace");

    const researchAfterSignOut = await page.request.get(yahooUrl, {
      headers: { Accept: "application/json" },
    });
    expect(researchAfterSignOut.status()).toBe(401);

    const terminalStillSignedIn = await page.request.get(new URL("/api/quotes?symbols=SPY", terminalOrigin).toString(), {
      headers: { Accept: "application/json" },
    });
    expect(terminalStillSignedIn.status()).toBe(200);
    expect(JSON.stringify(safeSessionCookieMetadata)).not.toContain(SECRET_SENTINEL_PREFIX);
  } finally {
    await context.close();
  }
});
