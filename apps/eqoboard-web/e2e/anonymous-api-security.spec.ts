import { expect, test } from "@playwright/test";

type CounterSnapshot = Readonly<{ calls: Readonly<Record<string, number>> }>;

const GATEWAY_DISPATCH_ROUTES = [
  "/api/v1/status",
  "/api/v1/stocks/snapshots",
  "/api/v1/stocks/bars",
  "/api/v1/options/chain",
  "/api/v1/subscriptions/stocks",
  "/api/v1/subscriptions/options",
  "/api/v1/orders/preview",
  "/api/v1/stream/sse",
] as const;

function webOrigin(): string {
  const origin = process.env.E2E_WEB_ORIGIN;
  if (!origin) throw new Error("E2E_WEB_ORIGIN must point at the production Compose image.");
  return origin;
}

function fixtureControlOrigin(): string {
  const origin = process.env.E2E_FIXTURE_CONTROL_ORIGIN;
  if (!origin) throw new Error("E2E_FIXTURE_CONTROL_ORIGIN must point at the isolated mock Gateway control listener.");
  return origin;
}

test("@api anonymous BFF reads fail before any protected data can be returned", async ({ page }) => {
  const origin = webOrigin();
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  for (const path of ["/api/quotes?symbols=SPY", "/api/workspaces"]) {
    const response = await page.request.get(new URL(path, origin).toString(), {
      headers: { Accept: "application/json" },
    });
    expect(response.status(), path).toBe(401);
    expect(response.headers()["cache-control"]).toMatch(/no-store/u);
    expect(response.headers()["content-type"]).toMatch(/application\/json/iu);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  }
});

test("@api every published protected data route rejects anonymous access before Gateway dispatch", async ({ page, request }) => {
  const origin = webOrigin();
  const sameOrigin = new URL(origin).origin;
  const reset = await request.post(new URL("/__test/counters/reset", fixtureControlOrigin()).toString());
  expect(reset.status()).toBe(200);

  const jsonHeaders = { Accept: "application/json", "Content-Type": "application/json", Origin: sameOrigin };
  const requests = [
    { method: "GET", path: "/api/quotes?symbols=SPY" },
    { method: "GET", path: "/api/history/SPY?range=1D" },
    { method: "GET", path: "/api/options/SPY?expiry=2026-10-16" },
    { method: "GET", path: "/api/status" },
    { method: "GET", path: "/api/eqo/live" },
    { method: "GET", path: "/api/eqo/engine/status" },
    { method: "GET", path: "/api/eqo/engine/preview" },
    { method: "GET", path: "/api/eqo/research/predictions/run-acceptance" },
    { method: "GET", path: "/api/eqo/market-data/datasets/fixture-1/bars?namespace=diagnostic&symbol=SPY" },
    { method: "GET", path: "/api/research/data/news?symbol=SPY" },
    { method: "GET", path: "/api/research/data/macro?region=us" },
    { method: "GET", path: "/api/research/data/economic-calendar" },
    { method: "GET", path: "/api/research/data/earnings-calendar?symbols=SPY%2CQQQ" },
    { method: "GET", path: "/api/research/data/earnings-history?symbol=SPY" },
    { method: "GET", path: "/api/research/data/insider?symbol=SPY" },
    { method: "GET", path: "/api/research/data/screener?market=us&limit=25" },
    { method: "GET", path: "/api/research/data/heatmap?market=us" },
    { method: "GET", path: "/api/research/data/crypto" },
    { method: "GET", path: "/api/research/data/crypto-global" },
    { method: "GET", path: "/api/workspaces" },
    { method: "PUT", path: "/api/workspaces", headers: { ...jsonHeaders, "If-Match": '"0"' }, data: { schemaVersion: 1, document: null } },
    { method: "GET", path: "/api/portfolios" },
    { method: "POST", path: "/api/portfolios", headers: jsonHeaders, data: { name: "anonymous-write-must-not-persist" } },
    { method: "GET", path: "/api/portfolios/1/positions" },
    { method: "GET", path: "/api/portfolios/1/transactions" },
    { method: "POST", path: "/api/portfolios/1/transactions", headers: jsonHeaders, data: {} },
    { method: "DELETE", path: "/api/portfolios/1", headers: jsonHeaders },
    { method: "DELETE", path: "/api/portfolios/1/transactions/1", headers: jsonHeaders },
    { method: "POST", path: "/api/research/ai", headers: jsonHeaders, data: {} },
    { method: "POST", path: "/api/eqo/stocks/subscribe", headers: jsonHeaders, data: {} },
    { method: "POST", path: "/api/eqo/options/subscribe", headers: jsonHeaders, data: {} },
    { method: "POST", path: "/api/eqo/orders/preview", headers: jsonHeaders, data: {} },
  ] as const;
  for (const route of requests) {
    const response = await page.request.fetch(new URL(route.path, origin).toString(), {
      method: route.method,
      headers: "headers" in route ? route.headers : { Accept: "application/json" },
      ...( "data" in route ? { data: route.data } : {}),
    });
    expect(response.status(), `${route.method} ${route.path}`).toBe(401);
    expect(response.headers()["cache-control"], `${route.method} ${route.path}`).toMatch(/no-store/u);
    expect(response.headers()["content-type"], `${route.method} ${route.path}`).toMatch(/application\/json/iu);
    expect(await response.json(), `${route.method} ${route.path}`).toEqual({ error: "unauthenticated" });
  }

  const countersResponse = await request.get(new URL("/__test/counters", fixtureControlOrigin()).toString());
  expect(countersResponse.status()).toBe(200);
  const counters = await countersResponse.json() as CounterSnapshot;
  for (const route of GATEWAY_DISPATCH_ROUTES) {
    expect(counters.calls[route] ?? 0, `anonymous request must not dispatch to ${route}`).toBe(0);
  }
  const unexpectedDownstreamPaths = Object.keys(counters.calls).filter((path) =>
    path.startsWith("/api/v1/") && !GATEWAY_DISPATCH_ROUTES.includes(path as typeof GATEWAY_DISPATCH_ROUTES[number]),
  );
  expect(unexpectedDownstreamPaths, "anonymous routes must not dispatch to unrecognized Gateway paths").toEqual([]);
});

test("@api the internal research session check is not a public endpoint", async ({ request }) => {
  const response = await request.get(new URL("/api/research/auth-check", webOrigin()).toString(), {
    headers: { Accept: "application/json" },
  });
  expect(response.status()).toBe(404);
});
