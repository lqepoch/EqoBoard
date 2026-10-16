import { expect, test } from "@playwright/test";

test("packaged workstation opens without OIDC and persists an owned workspace", async ({
  page,
  request,
}) => {
  const origins: string[] = [];
  page.on("request", (req) => origins.push(new URL(req.url()).origin));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  await expect(page.getByTestId("sign-in-button")).toHaveCount(0);
  const selector = page.getByTestId("workspace-selector");
  await expect(selector.locator("option").first()).toBeAttached();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  const originalCount = await selector.locator("option").count();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await expect(selector.locator("option")).toHaveCount(originalCount + 1);
  const selected = await selector.inputValue();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  await expect(selector).toHaveValue(selected);
  const response = await request.get("/api/workspaces");
  expect(response.status()).toBe(200);
  expect(response.headers()["etag"]).toBeTruthy();
  const serialized = JSON.stringify(await response.json());
  expect(serialized).not.toContain("NATIVE_LOCAL_PROVIDER_SECRET_SENTINEL");
  const statusResponse = await request.get("/api/status");
  expect(statusResponse.status()).toBe(200);
  expect(await statusResponse.json()).toMatchObject({
    market_data_provider: "futu",
    execution_mode: "disabled",
    execution_enabled: false,
  });
  expect(await page.content()).not.toContain("NATIVE_LOCAL_PROVIDER_SECRET_SENTINEL");
  expect(await page.content()).not.toContain("NATIVE_LOCAL_PARENT_SECRET_SENTINEL");
  expect([...new Set(origins)]).toEqual(["http://127.0.0.1:3000"]);
});

test("packaged local identity rejects foreign and proxy origins before storage writes", async ({
  request,
}) => {
  const rejectedHeaders: Record<string, string>[] = [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "X-Forwarded-Host": "foreign.invalid" },
    { "X-Forwarded-Proto": "https" },
    { "X-Forwarded-Port": "443" },
    { Forwarded: "host=foreign.invalid;proto=https" },
  ];
  for (const headers of rejectedHeaders) {
    expect((await request.get("/api/workspaces", { headers })).status()).toBe(403);
  }
  expect(
    (
      await request.put("/api/workspaces", {
        headers: { "Content-Type": "application/json" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect((await request.get("/api/workspaces")).status()).toBe(200);
});
