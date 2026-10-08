import { configureMocks, expect, loginWithOidc, metrics, resetDownstream, test, WEB_ORIGIN } from "./fixtures";

test.beforeEach(async ({ request }) => resetDownstream(request));

test("native ChartWidget plots validated diagnostic bars and clears them when source changes", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await page.goto(WEB_ORIGIN);
  const chart = page.getByTestId("chart-widget");
  await chart.getByRole("button", { name: "MDP DIAGNOSTIC" }).click();
  const dataset = page.getByTestId("mdp-dataset-id");
  await dataset.fill("synthetic-e2e-bars-v1");
  await page.getByRole("button", { name: "LOAD ARCHIVE" }).click();

  await expect(chart.getByText(/Diagnostic archive · synthetic\/synthetic\/unknown · synthetic_eof/)).toBeVisible();
  await expect(chart.getByText("NOT LIVE", { exact: false })).toBeVisible();
  await expect(chart.getByText("500.00", { exact: true }).first()).toBeVisible();
  const service = await metrics(request);
  expect(service.mdp.authorized).toBe(1);
  expect(service.mdp.calls[0]).toMatchObject({
    method: "GET",
    path: "/v1/datasets/synthetic-e2e-bars-v1/bars",
    namespace: "diagnostic",
    symbol: "QQQ",
  });

  await chart.getByRole("button", { name: "PROVIDER HISTORY" }).click();
  await expect(chart.getByText(/Diagnostic archive/)).toHaveCount(0);
  expect((await metrics(request)).mdp.authorized).toBe(1);
});

test("native chart rejects out-of-range numeric projections without plotting non-finite values", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const valid = await page.context().request.get(
    "/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ",
  );
  expect(valid.status()).toBe(200);
  const response = await valid.json();
  Object.assign(response.rows[0], {
    open: "1000000000001",
    high: "1000000000002",
    low: "1000000000000.5",
    close: "1000000000001.5",
  });
  await configureMocks(request, { mdpResponse: response });

  await page.goto(WEB_ORIGIN);
  await page.getByTestId("chart-widget").getByRole("button", { name: "MDP DIAGNOSTIC" }).click();
  await page.getByTestId("mdp-dataset-id").fill("synthetic-e2e-bars-v1");
  await page.getByRole("button", { name: "LOAD ARCHIVE" }).click();
  await expect(page.getByText("Archive values exceed the bounded chart projection; no bars were plotted.")).toBeVisible();
  await expect(page.getByText("1000000000001", { exact: true })).toHaveCount(0);
});
