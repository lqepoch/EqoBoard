import { configureMocks, loginWithOidc, metrics, resetDownstream, test, expect } from "./fixtures";
import { futureFridayOCCDate } from "./market-test-data";

const previewId = "00000000-0000-4000-8000-000000000001";
const clientOrderId = "client-order-unknown-e2e-17";
const expiration = futureFridayOCCDate();
const expirationDate = `20${expiration.slice(0, 2)}-${expiration.slice(2, 4)}-${expiration.slice(4)}`;
const contracts = [
  { symbol: `QQQ${expiration}P00620000`, right: "put", strike: 620, bid: 1.10, ask: 1.20,
    last: 1.15, iv: null, delta: null, gamma: null, theta: null, vega: null,
    bid_size: 1, ask_size: 1, updated_at: null },
  { symbol: `QQQ${expiration}P00600000`, right: "put", strike: 600, bid: 0.10, ask: 0.20,
    last: 0.15, iv: null, delta: null, gamma: null, theta: null, vega: null,
    bid_size: 1, ask_size: 1, updated_at: null },
];

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
});

test("a late preview cannot restore A after the form changes A to B and back to A", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader", "eqoboard-order-reviewer"]);
  await configureMocks(request, { previewDelaysMs: [5_000, 0], contracts });
  await page.goto("/");
  await page.getByLabel("Option expiry").fill(expirationDate);
  await expect(page.locator('[row-id="620"]')).toBeVisible();
  await page.locator('[row-id="620"] [col-id="put.last"]').click();
  await page.locator('[row-id="600"] [col-id="put.last"]').click();
  await expect(page.getByLabel("Leg 1 side")).toHaveValue("buy");
  await expect(page.getByLabel("Leg 2 side")).toHaveValue("sell");

  const limit = page.getByLabel("Limit price");
  await limit.fill("0.01");
  let firstResponseResolved = false;
  const lateResponse = page.waitForResponse((response) =>
    response.url().includes("/api/eqo/orders/preview") && response.request().method() === "POST")
    .then((response) => {
      firstResponseResolved = true;
      return response;
    });
  const firstRequest = page.waitForRequest((request) =>
    request.url().includes("/api/eqo/orders/preview") && request.method() === "POST");
  await page.getByRole("button", { name: /RISK PREVIEW/ }).click();
  const requestStarted = await firstRequest;
  const firstPayload = requestStarted.postDataJSON();
  expect(firstPayload.limit_price).toBe(0.01);

  await limit.fill("0.02");
  await limit.fill("0.01");
  expect(firstResponseResolved).toBe(false);
  const delayed = await lateResponse;
  expect(delayed.status()).toBe(200);
  const stalePreview = (await delayed.json()).preview;
  expect(stalePreview.estimated_max_loss).toBe(1);
  expect(stalePreview.currency).toBe("USD");
  expect(stalePreview.intent).toEqual(firstPayload);
  await expect(page.getByTestId("locked-preview")).toHaveCount(0);

  await expect(page.getByRole("button", { name: /RISK PREVIEW/ })).toBeEnabled();
  const currentResponse = page.waitForResponse((response) =>
    response.url().includes("/api/eqo/orders/preview") && response.request().method() === "POST");
  await page.getByRole("button", { name: /RISK PREVIEW/ }).click();
  const confirmedResponse = await currentResponse;
  expect(confirmedResponse.status()).toBe(200);
  const confirmedPreview = (await confirmedResponse.json()).preview;
  expect(confirmedPreview.preview_id).not.toBe(stalePreview.preview_id);
  expect(confirmedPreview).toMatchObject({ estimated_max_loss: 1, currency: "USD", intent: firstPayload });
  await expect(page.getByTestId("locked-preview")).toBeVisible();
  await expect(page.getByTestId("locked-preview")).toContainText("0.01");
  await expect(page.getByTestId("locked-preview")).toContainText("USD 1.00");
  await expect(page.getByTestId("locked-preview").locator("code")).toHaveText(confirmedPreview.preview_id);
  await expect(page.getByRole("button", { name: /PAPER SUBMIT BLOCKED/ })).toBeDisabled();

  const observed = await metrics(request);
  expect(observed.gateway.previews).toHaveLength(2);
  expect(observed.gateway.previews.map((entry: { body: { limit_price: number } }) => entry.body.limit_price))
    .toEqual([0.01, 0.01]);
  expect(observed.gateway.requests["/api/v1/orders/submit"]).toBeUndefined();
});

test("[dev-only] typed UNKNOWN browser outcome keeps the client order ID and forbids replacement", async ({ page, request }) => {
  test.skip(process.env.E2E_PRODUCTION === "1", "UNKNOWN panel fixture is only exercised by the development browser suite");
  await loginWithOidc(page, request, ["eqoboard-market-reader", "eqoboard-order-reviewer"]);
  await page.route("**/api/eqo/orders/submit", (route) => route.fulfill({
    status: 502,
    contentType: "application/json",
    body: JSON.stringify({
      state: "unknown",
      client_order_id: clientOrderId,
      retryable: false,
      recovery_required: true,
      detail: `The response was lost while reconciling preview ${previewId}.`,
    }),
  }));
  await page.goto("/e2e/order-outcome");
  await page.getByRole("button", { name: "Confirm existing preview fixture" }).click();
  const outcome = page.getByTestId("order-outcome");
  await expect(outcome).toContainText("Order outcome: UNKNOWN");
  await expect(outcome).toContainText(clientOrderId);
  await expect(outcome).toContainText("Keep this ID for reconciliation. Do not submit a replacement order.");
  await expect(page.getByRole("button", { name: /submit|retry|replacement/i })).toHaveCount(0);
  expect((await metrics(request)).gateway.requests["/api/v1/orders/submit"]).toBeUndefined();
});

test("production build does not expose the order-outcome fixture route", async ({ request }) => {
  test.skip(process.env.E2E_PRODUCTION !== "1", "Production route assertion runs in the container browser suite");
  const response = await request.get("/e2e/order-outcome");
  expect(response.status()).toBe(404);
});
