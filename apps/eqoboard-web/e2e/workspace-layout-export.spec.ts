import { readFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

function webOrigin(): string {
  const origin = process.env.E2E_WEB_ORIGIN;
  if (!origin) throw new Error("E2E_WEB_ORIGIN must point at the production Compose image.");
  return origin;
}

function candidateSha(): string {
  const sha = process.env.E2E_CANDIDATE_SHA;
  if (!sha || !/^[0-9a-f]{40}$/iu.test(sha)) {
    throw new Error(
      "E2E_CANDIDATE_SHA must be the frozen native source-head SHA supplied by the Compose helper.",
    );
  }
  return sha.toLowerCase();
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

test("signed-in workspace tabs survive reload and export contains layout-only data", async ({
  page,
}, testInfo: TestInfo) => {
  const authenticationStartedAt = Date.now();
  await signInAsWriter(page);
  const firstUsableWorkspaceMs = Date.now() - authenticationStartedAt;

  const workspaceSelector = page.getByLabel("Workspace");
  const previousWorkspaceId = await workspaceSelector.inputValue();
  const previousWorkspaceIds = await workspaceSelector.locator("option").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  const saveStartedAt = Date.now();
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(workspaceSelector.locator("option")).toHaveCount(previousWorkspaceIds.length + 1);
  const workspaceId = await workspaceSelector.inputValue();
  expect(workspaceId).not.toBe(previousWorkspaceId);
  expect(previousWorkspaceIds).not.toContain(workspaceId);
  const selectedWorkspaceName = await workspaceSelector.locator("option:checked").textContent();
  if (!selectedWorkspaceName?.trim()) {
    throw new Error("The new workspace was not selected after creation.");
  }
  const workspaceName = selectedWorkspaceName.trim();
  const tabs = page.getByRole("tablist", { name: "Workspace tabs" });
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByTestId("workspace-add-tab").click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(tabs.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("workspace-duplicate-tab").click();
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(tabs.getByRole("tab", { name: "New tab copy" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );
  const workspaceMutationSaveMs = Date.now() - saveStartedAt;

  const duplicateTab = tabs.getByRole("tab", { name: "New tab copy" });
  await duplicateTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: "New tab" })).toBeFocused();
  await expect(tabs.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true");

  const reloadStartedAt = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );
  const workspaceReloadUsableMs = Date.now() - reloadStartedAt;
  await expect(page.getByLabel("Workspace")).toHaveValue(workspaceId);
  const reloadedTabs = page.getByRole("tablist", { name: "Workspace tabs" }).getByRole("tab");
  await expect(reloadedTabs).toHaveCount(3);
  await expect(reloadedTabs.nth(0)).toHaveText("Overview");
  await expect(reloadedTabs.nth(1)).toHaveText("New tab");
  await expect(reloadedTabs.nth(2)).toHaveText("New tab copy");
  await expect(reloadedTabs.nth(1)).toHaveAttribute("aria-selected", "true");

  await page.getByText("Import or export", { exact: true }).click();
  const downloadReady = page.waitForEvent("download");
  await page.getByTestId("workspace-export").click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe("eqoboard-workspaces.json");
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  if (!downloadPath) throw new Error("The browser did not retain the workspace export.");
  const serialized = await readFile(downloadPath, "utf8");
  const exportPayloadBytes = Buffer.byteLength(serialized, "utf8");
  const envelope = JSON.parse(serialized) as Record<string, unknown>;
  expect(Object.keys(envelope).sort()).toEqual(["document", "format", "schemaVersion"]);
  expect(envelope).toMatchObject({ format: "eqoboard.workspace-export", schemaVersion: 1 });
  const document = envelope.document as {
    activeWorkspaceId: string;
    workspaces: Array<{ id: string; name: string; tabs: Array<{ id: string; name: string }> }>;
  };
  const activeWorkspace = document.workspaces.find(({ id }) => id === document.activeWorkspaceId);
  expect(activeWorkspace?.name).toBe(workspaceName);
  expect(activeWorkspace?.tabs.map(({ name }) => name)).toEqual([
    "Overview",
    "New tab",
    "New tab copy",
  ]);
  expect(JSON.stringify(envelope)).not.toMatch(
    /native-e2e-writer|workspace-editor|access.?token|refresh.?token|account|broker|order|quote|bar/iu,
  );

  const navigationMetrics = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      responseStartMs: entry?.responseStart ?? null,
      domContentLoadedMs: entry?.domContentLoadedEventEnd ?? null,
      transferBytes: entry?.transferSize ?? null,
      encodedBodyBytes: entry?.encodedBodySize ?? null,
      decodedBodyBytes: entry?.decodedBodySize ?? null,
    };
  });
  await testInfo.attach("native-workspace-candidate-sample", {
    body: JSON.stringify(
      {
        evidenceStatus: "candidate-sample-only",
        pairedLegacyBaseline: "NOT_RUN",
        candidateSha: candidateSha(),
        browserVersion: page.context().browser()?.version() ?? null,
        sampleCount: 1,
        phases: {
          firstUsableWorkspaceAfterOidcMs: firstUsableWorkspaceMs,
          workspaceMutationToSavedMs: workspaceMutationSaveMs,
          workspaceReloadToUsableMs: workspaceReloadUsableMs,
        },
        exportPayloadBytes,
        navigationMetrics,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
