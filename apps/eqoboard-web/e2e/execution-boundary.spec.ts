import { expect, test } from "@playwright/test";

type CounterSnapshot = Readonly<{ calls: Readonly<Record<string, number>> }>;

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

test("@api legacy Pro query and Futu order path cannot activate simulated execution", async ({ page, request }) => {
  const controlOrigin = fixtureControlOrigin();
  const reset = await request.post(new URL("/__test/counters/reset", controlOrigin).toString());
  expect(reset.status()).toBe(200);
  const appOrigin = new URL(webOrigin()).origin;
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== appOrigin) externalRequests.push(request.url());
  });

  const url = new URL("/", webOrigin());
  url.searchParams.set("view", "pro");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("access-state")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/PAPER_READY|FILLED|simulator-fallback/i);
  await expect(page.getByTestId("primary-navigation").getByRole("link", { name: "Workspace" }))
    .toHaveAttribute("aria-current", "page");

  const legacySubmit = await page.request.post(new URL("/api/futu/order", webOrigin()).toString(), {
    data: { symbol: "SPY", side: "BUY", quantity: 1, source: "acceptance-negative-test" },
    headers: { "Content-Type": "application/json" },
  });
  expect(legacySubmit.status()).toBe(404);
  const responseBody = await legacySubmit.text();
  expect(responseBody).not.toMatch(/success\s*[:=]\s*true|PAPER_READY|FILLED/i);
  expect(externalRequests).toEqual([]);

  const countersResponse = await request.get(new URL("/__test/counters", controlOrigin).toString());
  expect(countersResponse.status()).toBe(200);
  const counters = await countersResponse.json() as CounterSnapshot;
  expect(counters.calls["/api/v1/orders/preview"] ?? 0).toBe(0);
});
