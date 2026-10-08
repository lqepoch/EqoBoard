import { expect, loginWithOidc, resetDownstream, setRoles, test } from "./fixtures";

const configuredResearchOrigin = process.env.E2E_RESEARCH_PUBLIC_ORIGIN;
const expectResearchNavigation = process.env.E2E_EXPECT_RESEARCH_VISIBLE === "1";

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
  await setRoles(request, ["eqoboard-market-reader"]);
});

test("optional OpenBB Research navigation is isolated from the native terminal", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await page.goto("/");

  const sidebar = page.getByRole("navigation");
  const sidebarLink = sidebar.getByRole("link", { name: /OpenBB Research/ });

  if (!expectResearchNavigation) {
    await expect(sidebarLink).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "CHART" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("link", { name: /OpenBB Research/ })).toHaveCount(0);
    return;
  }

  if (!configuredResearchOrigin) throw new Error("E2E_RESEARCH_PUBLIC_ORIGIN must be set when expecting a Research link");
  const origin = new URL(configuredResearchOrigin).origin;
  await expect(sidebarLink).toHaveAttribute("href", origin);
  await expect(sidebarLink).toHaveAttribute("target", "_blank");
  await expect(sidebarLink).toHaveAttribute("rel", "noopener noreferrer");

  await page.context().route(`${origin}/**`, (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>External destination fixture</title><p>External destination fixture</p>",
  }));

  const sidebarPopupPromise = page.waitForEvent("popup");
  await sidebarLink.focus();
  await sidebarLink.press("Enter");
  const sidebarPopup = await sidebarPopupPromise;
  await expect(sidebarPopup).toHaveURL(`${origin}/`);
  await expect(sidebarPopup.getByText("External destination fixture")).toBeVisible();
  expect(await sidebarPopup.evaluate(() => window.opener === null)).toBe(true);
  await sidebarPopup.close();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const input = palette.getByRole("textbox");
  await input.fill("OpenBB Research");
  const paletteLink = palette.getByRole("link", { name: /OpenBB Research/ });
  await expect(paletteLink).toHaveAttribute("href", origin);
  await expect(paletteLink).toHaveAttribute("target", "_blank");
  await expect(paletteLink).toHaveAttribute("rel", "noopener noreferrer");

  const palettePopupPromise = page.waitForEvent("popup");
  await input.press("Enter");
  const palettePopup = await palettePopupPromise;
  await expect(palettePopup).toHaveURL(`${origin}/`);
  await expect(palettePopup.getByText("External destination fixture")).toBeVisible();
  expect(await palettePopup.evaluate(() => window.opener === null)).toBe(true);
});

test("repeated OIDC login and health navigation close every authenticated market stream", async ({ browser, request }) => {
  test.setTimeout(45_000);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const page = await browser.newPage();
    try {
      await loginWithOidc(page, request, ["eqoboard-market-reader"]);
    } finally {
      await page.close();
    }
  }
});
