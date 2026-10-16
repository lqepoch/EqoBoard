import { expect, test } from "@playwright/test";

test("@component synthetic tape renders through the shared BFF stream and clears a prior epoch", async ({
  page,
  request,
}) => {
  const origin = process.env.E2E_WEB_ORIGIN;
  const control = process.env.E2E_FIXTURE_CONTROL_ORIGIN;
  if (!origin || !control) throw new Error("Production image and isolated fixture are required");
  const streams: number[] = [];
  const external: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.origin !== origin && url.origin !== "http://native-mock-oidc:4450") {
      external.push(req.url());
    }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/eqo/live") streams.push(response.status());
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("mock-login-writer").click();
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Option tape/u }).click();
  const tape = page.getByTestId("market-option-tape-widget");
  await expect(tape).toBeVisible();
  await page.getByRole("button", { name: "Maximize Option tape", exact: true }).click();
  await expect.poll(() => streams).toEqual([200]);

  async function publish(step: string) {
    const response = await request.post(new URL("/__test/market", control).toString(), {
      data: { step },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ published: 1 });
  }

  await publish("initial");
  const rows = tape.locator(".ag-center-cols-container [role=row]");
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('[col-id="price"]')).toHaveText("4.25");
  // Event time is deliberately missing even though Gateway receive time exists.
  await expect(rows.locator('[col-id="eventAt"]')).toHaveText("unknown");
  await expect(rows.locator('[col-id="receivedAt"]')).toHaveText("2026-10-16T14:30:01Z");
  await publish("stale");
  await publish("epoch");
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('[col-id="price"]')).toHaveText("5.5");
  await expect(tape).not.toContainText("999");
  expect(streams).toEqual([200]);
  expect(external).toEqual([]);
});
