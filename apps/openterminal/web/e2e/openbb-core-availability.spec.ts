import { expect, test } from "@playwright/test";

const TERMINAL_ORIGIN = process.env.EQO_PUBLIC_ORIGIN!;
const MAIN_STORAGE_STATE = process.env.OPENBB_MAIN_E2E_STORAGE_STATE!;

test.use({ storageState: MAIN_STORAGE_STATE });

test("signed-in native OpenTerminal workspace stays usable while optional OpenBB services are stopped", async ({ page }) => {
  const ready = await page.request.get(`${TERMINAL_ORIGIN}/api/readyz`);
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toMatchObject({ runtime_mode: "terminal", execution_enabled: false });

  const response = await page.goto(TERMINAL_ORIGIN);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("navigation").getByText("Add widget", { exact: true })).toBeVisible();
  await expect(page.getByText("Execution: disabled", { exact: true })).toBeVisible();
  const workspace = page.getByRole("main");
  await expect(workspace.locator(".terminal-panel").first()).toBeVisible();
  await expect(workspace.locator(".terminal-panel").filter({ hasText: /quote/i }).first()).toBeVisible();
  await expect(page.getByText(/paper submission blocked/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /PAPER SUBMIT BLOCKED/ })).toBeDisabled();
  await page.screenshot({ path: `${process.env.OPENBB_E2E_ARTIFACT_DIR}/native-terminal-openbb-stopped.png`, fullPage: true });
});
