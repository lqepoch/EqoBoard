import { expect, test, type Page } from "@playwright/test";

const LEGACY_KEY = "eqoboard-open-terminal-v1";

function webOrigin(): string {
  const origin = process.env.E2E_WEB_ORIGIN;
  if (!origin) throw new Error("E2E_WEB_ORIGIN must point at the production Compose image.");
  return origin;
}

function legacyLayout(): string {
  return JSON.stringify({
    version: 0,
    state: {
      activeSymbol: "QQQ",
      widgets: [
        { id: "legacy-quote-id", type: "quote", linked: false, symbol: "AAPL" },
        { id: "legacy-tv-id", type: "tv", linked: true },
      ],
      layout: [
        { i: "legacy-quote-id", x: 0, y: 0, w: 4, h: 4 },
        { i: "legacy-tv-id", x: 4, y: 0, w: 4, h: 4 },
      ],
      watchlist: ["QQQ", "SPY"],
      commandOpen: true,
      optionLegs: [{ symbol: "QQQ261016C00500000", side: "buy" }],
    },
  });
}

async function signInAsWriter(page: Page): Promise<void> {
  await page.getByTestId("sign-in-button").click();
  const chooser = page.getByTestId("mock-login-writer");
  await expect(chooser).toBeVisible();
  await chooser.click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await expect(page.getByTestId("workspace-root")).toBeVisible();
}

test("@api legacy storage is preview-only anonymously and imports by explicit confirmation with fresh IDs", async ({
  page,
}) => {
  const rawLegacyLayout = legacyLayout();
  await page.addInitScript(
    ({ key, raw }) => {
      const reads: string[] = [];
      const originalGetItem = Storage.prototype.getItem;
      Object.defineProperty(window, "__nativeLegacyStorageReads", {
        value: reads,
        configurable: true,
      });
      Storage.prototype.getItem = function getItem(name: string): string | null {
        if (name === key) reads.push(name);
        return originalGetItem.call(this, name);
      };
      window.localStorage.setItem(key, raw);
    },
    { key: LEGACY_KEY, raw: rawLegacyLayout },
  );

  await page.goto(webOrigin(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("access-state")).toContainText("Sign in to open your workspace");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __nativeLegacyStorageReads: string[] }).__nativeLegacyStorageReads
          .length,
    ),
  ).toBe(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY)).toBe(rawLegacyLayout);

  await page.getByTestId("workspace-legacy-import-preview").click();
  await expect(page.getByTestId("workspace-legacy-import-preview-result")).toContainText(
    "2 widgets",
  );
  const anonymousConfirm = page.getByTestId("workspace-legacy-import-confirm");
  await expect(anonymousConfirm).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __nativeLegacyStorageReads: string[] }).__nativeLegacyStorageReads
          .length,
    ),
  ).toBe(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY)).toBe(rawLegacyLayout);

  await signInAsWriter(page);
  const beforeExplicitImport = await page.request.get(
    new URL("/api/workspaces", webOrigin()).toString(),
    {
      headers: { Accept: "application/json" },
    },
  );
  expect(beforeExplicitImport.status()).toBe(200);
  expect(JSON.stringify(await beforeExplicitImport.json())).not.toContain(
    "Imported OpenTerminal layout",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY)).toBe(rawLegacyLayout);

  await page.getByTestId("workspace-legacy-import-preview").click();
  await expect(page.getByTestId("workspace-legacy-import-preview-result")).toContainText(
    "Unsupported legacy types retained as inert tiles: tv",
  );
  await expect(page.getByTestId("workspace-legacy-import-confirm")).toBeEnabled();
  await page.getByTestId("workspace-legacy-import-confirm").click();
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );
  await expect(page.locator("body")).toContainText("Imported as a new workspace");

  const importedResponse = await page.request.get(
    new URL("/api/workspaces", webOrigin()).toString(),
    {
      headers: { Accept: "application/json" },
    },
  );
  expect(importedResponse.status()).toBe(200);
  const saved = (await importedResponse.json()) as {
    schemaVersion: number;
    document: {
      workspaces: Array<{
        id: string;
        name: string;
        marketContext: { activeSymbol: string; watchlist: string[] };
        tabs: Array<{
          id: string;
          widgets: Array<{
            instanceId: string;
            manifestId: string;
            config: unknown;
            symbolBinding?: unknown;
          }>;
        }>;
      }>;
      userTemplates: unknown[];
    };
  };
  expect(saved.schemaVersion).toBe(1);
  const imported = saved.document.workspaces.find(
    (workspace) => workspace.name === "Imported OpenTerminal layout",
  );
  expect(imported).toBeDefined();
  if (!imported) return;
  expect(imported?.marketContext).toEqual({ activeSymbol: "QQQ", watchlist: ["QQQ", "SPY"] });
  const importedTab = imported.tabs[0];
  expect(imported.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  expect(importedTab?.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  expect(imported?.tabs[0]?.widgets.map(({ manifestId }) => manifestId)).toEqual([
    "market.quote",
    "legacy.imported.tv",
  ]);
  const importedInstanceIds = importedTab?.widgets.map(({ instanceId }) => instanceId) ?? [];
  expect(new Set(importedInstanceIds).size).toBe(2);
  expect(importedInstanceIds).not.toContain("legacy-quote-id");
  expect(importedInstanceIds).not.toContain("legacy-tv-id");
  importedInstanceIds.forEach((instanceId) => {
    expect(instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });
  expect(imported?.tabs[0]?.widgets[0]?.symbolBinding).toEqual({ mode: "fixed", symbol: "AAPL" });
  expect(JSON.stringify(saved.document)).not.toMatch(/commandOpen|optionLegs|QQQ261016C00500000/u);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY)).toBe(rawLegacyLayout);

  const quoteInstance = importedTab?.widgets.find(
    ({ manifestId }) => manifestId === "market.quote",
  );
  expect(quoteInstance).toBeDefined();
  if (quoteInstance) {
    const quoteCard = page.locator(`[data-widget-instance-id="${quoteInstance.instanceId}"]`);
    await expect(quoteCard).toBeVisible();
    await expect(quoteCard.getByTestId("market-quote-widget")).toBeVisible();
  }
  const inertInstance = importedTab?.widgets.find(
    ({ manifestId }) => manifestId === "legacy.imported.tv",
  );
  expect(inertInstance).toBeDefined();
  if (inertInstance) {
    const inertCard = page.locator(`[data-widget-instance-id="${inertInstance.instanceId}"]`);
    await expect(inertCard).toBeVisible();
    await expect(inertCard.getByRole("heading", { name: "Unsupported widget" })).toBeVisible();
    await expect(inertCard).toContainText(
      "This widget type is not installed in the native registry.",
    );
  }
});

test("@api a changed legacy source cannot commit a stale preview to the signed-in owner", async ({
  page,
}) => {
  const original = legacyLayout();
  const changed = JSON.stringify({
    version: 0,
    state: {
      activeSymbol: "DIA",
      widgets: [{ id: "changed-legacy-quote", type: "quote", linked: true }],
      layout: [{ i: "changed-legacy-quote", x: 0, y: 0, w: 4, h: 4 }],
      watchlist: ["DIA"],
      commandOpen: false,
      optionLegs: [],
    },
  });
  await page.addInitScript(({ key, raw }) => window.localStorage.setItem(key, raw), {
    key: LEGACY_KEY,
    raw: original,
  });
  await page.goto(webOrigin(), { waitUntil: "domcontentloaded" });
  await signInAsWriter(page);
  await expect(page.locator("[aria-label='Workspace sync status']")).toContainText(
    "All changes saved",
  );
  const beforeResponse = await page.request.get(
    new URL("/api/workspaces", webOrigin()).toString(),
    {
      headers: { Accept: "application/json" },
    },
  );
  expect(beforeResponse.status()).toBe(200);
  const before = (await beforeResponse.json()) as { document: unknown };

  await page.getByTestId("workspace-legacy-import-preview").click();
  await expect(page.getByTestId("workspace-legacy-import-preview-result")).toContainText(
    "2 widgets",
  );
  await page.evaluate(({ key, raw }) => window.localStorage.setItem(key, raw), {
    key: LEGACY_KEY,
    raw: changed,
  });
  await page.getByTestId("workspace-legacy-import-confirm").click();
  await expect(page.locator("body")).toContainText(
    "The saved legacy layout changed after preview.",
  );
  await expect(page.getByTestId("workspace-legacy-import-preview-result")).toHaveCount(0);

  const response = await page.request.get(new URL("/api/workspaces", webOrigin()).toString(), {
    headers: { Accept: "application/json" },
  });
  expect(response.status()).toBe(200);
  const saved = (await response.json()) as { document: unknown };
  expect(saved.document).toEqual(before.document);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY)).toBe(changed);
});
