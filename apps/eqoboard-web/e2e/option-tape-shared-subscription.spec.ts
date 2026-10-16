import { expect, test } from "@playwright/test";

test("@component standalone Option Tape discloses its shared lease dependency and unknown coverage", async ({
  page,
  request,
}) => {
  const origin = process.env.E2E_WEB_ORIGIN;
  const control = process.env.E2E_FIXTURE_CONTROL_ORIGIN;
  if (!origin || !control) throw new Error("Production image and isolated fixture are required");

  const streams: number[] = [];
  const nonEmptyOptionMemberships: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/eqo/live") streams.push(response.status());
  });

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("mock-login-writer").click();
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await expect(page.getByTestId("market-options-chain-widget")).toHaveCount(0);
  await expect(page.getByTestId("market-iv-skew-widget")).toHaveCount(0);
  await page.getByRole("button", { name: "Add widget", exact: true }).click();

  // Ignore cleanup from widgets in the previously selected workspace. The
  // assertion below only rejects a new non-empty membership after this point.
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (
      url.origin !== origin ||
      url.pathname !== "/api/eqo/options/subscribe" ||
      req.method() !== "POST"
    )
      return;
    let symbols: unknown;
    try {
      const body: unknown = req.postDataJSON();
      symbols =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).symbols
          : undefined;
    } catch {
      symbols = undefined;
    }
    if (!Array.isArray(symbols)) nonEmptyOptionMemberships.push(-1);
    else if (symbols.length > 0) nonEmptyOptionMemberships.push(symbols.length);
  });

  await page.getByRole("menuitem", { name: /^Option tape/u }).click();

  const tape = page.getByTestId("market-option-tape-widget");
  await expect(tape).toBeVisible();
  await expect(tape).toContainText("does not request contracts itself");
  await expect(tape).toContainText(
    "leased by other active widgets such as Option Chain or IV Skew",
  );
  await expect(tape).toContainText("Tape-specific coverage is unknown");
  await page.getByRole("button", { name: "Maximize Option tape", exact: true }).click();
  await expect.poll(() => streams).toEqual([200]);

  const publish = await request.post(new URL("/__test/market", control).toString(), {
    data: { step: "initial" },
  });
  expect(publish.status()).toBe(200);
  expect(await publish.json()).toMatchObject({ published: 1 });
  const rows = tape.getByRole("row").filter({
    has: page.locator('[col-id="price"][role="gridcell"]'),
  });
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('[col-id="price"]')).toHaveText("4.25");
  expect(nonEmptyOptionMemberships).toEqual([]);
});
