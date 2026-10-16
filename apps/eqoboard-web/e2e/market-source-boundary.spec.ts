import { expect, test, type Page } from "@playwright/test";

type GatewayCounters = Readonly<{ calls: Readonly<Record<string, number>> }>;

function webOrigin(): string {
  const origin = process.env.E2E_WEB_ORIGIN;
  if (!origin) throw new Error("E2E_WEB_ORIGIN must point at the production Compose image.");
  return origin;
}

function gatewayControlOrigin(): string {
  const origin = process.env.E2E_FIXTURE_CONTROL_ORIGIN;
  if (!origin)
    throw new Error(
      "E2E_FIXTURE_CONTROL_ORIGIN must point at the isolated mock Gateway control listener.",
    );
  return origin;
}

async function signInAsWriter(page: Page): Promise<void> {
  await page.goto(webOrigin(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("mock-login-writer").click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await expect(page.getByTestId("workspace-root")).toBeVisible();
}

test("@component order-book depth remains unsupported with no source rows or provider dispatch", async ({
  page,
  request,
}) => {
  const appOrigin = new URL(webOrigin()).origin;
  const oidcOrigin = "http://native-mock-oidc:4450";
  const externalRequests: string[] = [];
  const forbiddenExecutionRequests: string[] = [];
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.origin !== appOrigin && url.origin !== oidcOrigin)
      externalRequests.push(browserRequest.url());
    if (/\/api\/(?:futu\/order|eqo\/orders\/(?:submit|preview))$/u.test(url.pathname)) {
      forbiddenExecutionRequests.push(`${browserRequest.method()} ${url.pathname}`);
    }
  });

  await signInAsWriter(page);
  const reset = await request.post(
    new URL("/__test/counters/reset", gatewayControlOrigin()).toString(),
  );
  expect(reset.status()).toBe(200);

  await page.getByRole("button", { name: "Add widget" }).click();
  const palette = page.getByRole("menu", { name: "Available widgets" });
  await palette.getByRole("menuitem", { name: /Order book/u }).click();

  const orderbook = page.getByTestId("market-orderbook-widget");
  await expect(orderbook).toBeVisible();
  await expect(orderbook.getByText("Unsupported", { exact: true })).toBeVisible();
  await expect(orderbook).toContainText(
    "No typed depth source is available; depth is not displayed.",
  );
  await expect(orderbook.locator("table,[role=grid],[data-row-index]")).toHaveCount(0);
  await expect(orderbook).not.toContainText(/bid|ask|size|price level|simulated|fixture quote/i);
  expect(externalRequests).toEqual([]);
  expect(forbiddenExecutionRequests).toEqual([]);

  const countersResponse = await request.get(
    new URL("/__test/counters", gatewayControlOrigin()).toString(),
  );
  expect(countersResponse.status()).toBe(200);
  const counters = (await countersResponse.json()) as GatewayCounters;
  for (const path of ["/api/v1/stocks/snapshots", "/api/v1/stocks/bars", "/api/v1/options/chain"]) {
    expect(
      counters.calls[path] ?? 0,
      `unsupported depth must not dispatch a market read to ${path}`,
    ).toBe(0);
  }
});
