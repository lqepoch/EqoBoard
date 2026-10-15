import { expect, test, type Page } from "@playwright/test";

function webOrigin(): string {
  const origin = process.env.E2E_WEB_ORIGIN;
  if (!origin) throw new Error("E2E_WEB_ORIGIN must point at the production Compose image.");
  return origin;
}

async function signInAsWriter(page: Page): Promise<void> {
  await page.goto(webOrigin(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("mock-login-writer").click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );
}

test("@component workspace recovery restores a tab after deletion and persists the rollback", async ({
  page,
}) => {
  await signInAsWriter(page);

  // Isolate this destructive scenario in a newly created owner workspace.
  await page.getByRole("button", { name: "New workspace" }).click();
  const workspaceTabs = page.getByRole("tablist", { name: "Workspace tabs" });
  await expect(workspaceTabs.getByRole("tab")).toHaveCount(1);
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );

  await page.getByTestId("workspace-add-tab").click();
  await expect(workspaceTabs.getByRole("tab")).toHaveCount(2);
  await expect(workspaceTabs.getByRole("tab", { name: "New tab" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );

  const deleteDialog = page.waitForEvent("dialog");
  const deleteClick = page.getByRole("button", { name: "Close New tab tab" }).click();
  const confirmation = await deleteDialog;
  expect(confirmation.message()).toContain("A local recovery copy will be written first");
  await confirmation.accept();
  await deleteClick;
  await expect(workspaceTabs.getByRole("tab")).toHaveCount(1);
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );

  const recovery = page.getByText("Recovery copies", { exact: true });
  await recovery.click();
  await page.getByRole("button", { name: "Load local recovery copies" }).click();
  const recoverySelector = page.getByLabel("Saved recovery point");
  const options = await recoverySelector.locator("option").evaluateAll((elements) =>
    elements.map((element) => ({
      label: (element as HTMLOptionElement).textContent ?? "",
      value: (element as HTMLOptionElement).value,
    })),
  );
  const deletedWorkspacePoint = options.find(({ label }) => label.endsWith("· delete"));
  expect(
    deletedWorkspacePoint,
    "tab deletion must first leave a partition-scoped recovery copy",
  ).toBeDefined();
  if (!deletedWorkspacePoint) {
    throw new Error("Tab deletion did not leave the expected partition-scoped recovery copy.");
  }
  await recoverySelector.selectOption(deletedWorkspacePoint.value);

  const restoreDialog = page.waitForEvent("dialog");
  const restoreClick = page.getByRole("button", { name: "Restore", exact: true }).click();
  const restoreConfirmation = await restoreDialog;
  expect(restoreConfirmation.message()).toContain("The current workspace will be backed up first");
  await restoreConfirmation.accept();
  await restoreClick;

  await expect(workspaceTabs.getByRole("tab")).toHaveCount(2);
  await expect(workspaceTabs.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(workspaceTabs.getByRole("tab", { name: "New tab" })).toBeVisible();
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );

  const persistedResponse = await page.request.get(
    new URL("/api/workspaces", webOrigin()).toString(),
    {
      headers: { Accept: "application/json" },
    },
  );
  expect(persistedResponse.status()).toBe(200);
  const persisted = (await persistedResponse.json()) as {
    document: {
      activeWorkspaceId: string;
      workspaces: Array<{ id: string; tabs: Array<{ name: string }> }>;
    };
  };
  const restoredWorkspace = persisted.document.workspaces.find(
    ({ id }) => id === persisted.document.activeWorkspaceId,
  );
  expect(restoredWorkspace?.tabs.map(({ name }) => name)).toEqual(["Overview", "New tab"]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Workspace tabs" }).getByRole("tab")).toHaveCount(
    2,
  );
});
