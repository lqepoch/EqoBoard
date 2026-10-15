import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

type CounterSnapshot = Readonly<{ calls: Readonly<Record<string, number>> }>;
const SECRET_SENTINEL_PREFIX = "NATIVE_SERVER_ONLY_SECRET_SENTINEL_20261015_";

function expectNoServerSecret(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(SECRET_SENTINEL_PREFIX);
}

function webOrigin(): string {
  const origin = process.env.E2E_WEB_ORIGIN;
  if (!origin) throw new Error("E2E_WEB_ORIGIN must point at the production Compose image.");
  return origin;
}

function fixtureControlOrigin(): string {
  const origin = process.env.E2E_FIXTURE_CONTROL_ORIGIN;
  if (!origin)
    throw new Error(
      "E2E_FIXTURE_CONTROL_ORIGIN must point at the isolated mock Gateway control listener.",
    );
  return origin;
}

async function resetGatewayCounters(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    new URL("/__test/counters/reset", fixtureControlOrigin()).toString(),
  );
  expect(response.status()).toBe(200);
}

async function gatewayCounters(request: APIRequestContext): Promise<CounterSnapshot> {
  const response = await request.get(
    new URL("/__test/counters", fixtureControlOrigin()).toString(),
  );
  expect(response.status()).toBe(200);
  const value = (await response.json()) as unknown;
  expect(value).toMatchObject({ calls: expect.any(Object) });
  return value as CounterSnapshot;
}

async function signIn(page: Page, role: "reader" | "writer"): Promise<void> {
  await page.goto(webOrigin(), { waitUntil: "domcontentloaded" });
  const authorizeResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.origin === "http://native-mock-oidc:4450" &&
      url.pathname === "/authorize" &&
      response.request().method() === "GET"
    );
  });
  await page.getByTestId("sign-in-button").click();
  const authorizeResponse = await authorizeResponsePromise;
  const csp = await authorizeResponse.headerValue("content-security-policy");
  expect(csp).toBeTruthy();
  const formActionDirective = csp
    ?.split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("form-action "));
  expect(formActionDirective?.split(/\s+/u)).toEqual([
    "form-action",
    "'self'",
    "http://native-mock-oidc:4450",
    `${new URL(webOrigin()).origin}/api/auth/callback/eqo-oidc`,
  ]);
  const chooser = page.getByTestId(`mock-login-${role}`);
  await expect(chooser).toBeVisible();
  await chooser.click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await expect(page.getByTestId("workspace-root")).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByTestId("account-menu").locator("summary").click();
  await page.getByTestId("account-menu").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("access-state")).toContainText("Sign in to open your workspace");
}

function workspaceDocument(name: string, workspaceId: string, tabId: string) {
  return {
    schemaVersion: 1,
    activeWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name,
        activeTabId: tabId,
        marketContext: { activeSymbol: "SPY", watchlist: ["SPY", "QQQ"] },
        tabs: [
          { id: tabId, name: "Overview", widgets: [], placements: [], maximizedInstanceId: null },
        ],
      },
    ],
    userTemplates: [],
  };
}

function putWorkspaceUrl(): string {
  return new URL("/api/workspaces", webOrigin()).toString();
}

async function writeWorkspace(
  page: Page,
  name: string,
  expectedEtag: string,
  suffix: string,
  origin = new URL(webOrigin()).origin,
) {
  const document = workspaceDocument(
    name,
    `11111111-1111-4111-8111-${suffix}`,
    `22222222-2222-4222-8222-${suffix}`,
  );
  return page.request.put(putWorkspaceUrl(), {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: origin,
      "If-Match": expectedEtag,
    },
    data: { schemaVersion: 1, document },
  });
}

test("@api signed OIDC ownership, workspace CAS, forged identity headers, logout, and cache partitioning", async ({
  browser,
  page,
  request,
}) => {
  const appOrigin = new URL(webOrigin()).origin;
  const issuerOrigin = "http://native-mock-oidc:4450";
  const unexpectedBrowserRequests: string[] = [];
  page.on("request", (browserRequest) => {
    const origin = new URL(browserRequest.url()).origin;
    if (origin !== appOrigin && origin !== issuerOrigin)
      unexpectedBrowserRequests.push(browserRequest.url());
  });
  await resetGatewayCounters(request);
  await page.goto(webOrigin(), { waitUntil: "domcontentloaded" });

  const anonymousQuote = await page.request.get(
    new URL("/api/quotes?symbols=SPY", webOrigin()).toString(),
    {
      headers: { Accept: "application/json" },
    },
  );
  expect(anonymousQuote.status()).toBe(401);
  const anonymousQuoteBody = await anonymousQuote.json();
  expect(anonymousQuoteBody).toEqual({ error: "unauthenticated" });
  expectNoServerSecret(anonymousQuoteBody);
  expect((await gatewayCounters(request)).calls["/api/v1/stocks/snapshots"] ?? 0).toBe(0);

  await signIn(page, "writer");
  const responseProjection = await page.evaluate(() => ({
    markup: document.documentElement.outerHTML,
    localStorage: Object.entries(localStorage),
    sessionStorage: Object.entries(sessionStorage),
  }));
  const browserVisibleState = JSON.stringify(responseProjection);
  expect(browserVisibleState).not.toMatch(
    /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/u,
  );
  expect(browserVisibleState).not.toMatch(
    /access[_-]?token|refresh[_-]?token|client[_-]?secret|broker[_-]?key/iu,
  );
  expect(browserVisibleState).not.toContain(SECRET_SENTINEL_PREFIX);
  expect(page.url()).not.toContain(SECRET_SENTINEL_PREFIX);
  expect(browserVisibleState).not.toContain("native-e2e-writer");
  expect(browserVisibleState).not.toContain("eqoboard-workspace-editor");
  const authSession = await page.request.get(new URL("/api/auth/session", webOrigin()).toString());
  expect(authSession.status()).toBe(200);
  const publicSession = (await authSession.json()) as unknown;
  expect(publicSession).toMatchObject({ expires: expect.any(String) });
  expect(Object.keys(publicSession as object).sort()).toEqual(["expires"]);
  expect(JSON.stringify(publicSession)).not.toMatch(
    /native-e2e-writer|workspace-editor|token|secret|issuer|subject/iu,
  );
  expectNoServerSecret(publicSession);
  const appScripts = await page
    .locator("script[src]")
    .evaluateAll((scripts) =>
      scripts
        .map((script) => (script as HTMLScriptElement).src)
        .filter((url) => new URL(url).origin === location.origin),
    );
  for (const scriptUrl of appScripts) {
    const script = await page.request.get(scriptUrl);
    expect(script.ok()).toBe(true);
    expect(await script.text()).not.toContain(SECRET_SENTINEL_PREFIX);
  }
  const browserCookies = await page.context().cookies(webOrigin());
  expect(JSON.stringify(browserCookies)).not.toContain(SECRET_SENTINEL_PREFIX);

  const portfolioName = `Native acceptance ${Date.now()}`;
  const createdPortfolio = await page.request.post(
    new URL("/api/portfolios", webOrigin()).toString(),
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: appOrigin,
      },
      data: { name: portfolioName },
    },
  );
  expect(createdPortfolio.status()).toBe(201);
  const portfolioRecord = (await createdPortfolio.json()) as {
    id: number;
    name: string;
    created_at: string;
  };
  expect(portfolioRecord).toMatchObject({
    id: expect.any(Number),
    name: portfolioName,
    created_at: expect.any(String),
  });
  expectNoServerSecret(portfolioRecord);
  expect(Object.keys(portfolioRecord).sort()).toEqual(["created_at", "id", "name"]);
  const ownPositions = await page.request.get(
    new URL(`/api/portfolios/${portfolioRecord.id}/positions`, webOrigin()).toString(),
    {
      headers: { Accept: "application/json" },
    },
  );
  expect(ownPositions.status()).toBe(200);
  const ownPositionsBody = await ownPositions.json();
  expect(ownPositionsBody).toEqual([]);
  expectNoServerSecret(ownPositionsBody);

  await resetGatewayCounters(request);
  const statusResponse = await page.request.get(new URL("/api/status", webOrigin()).toString(), {
    headers: { Accept: "application/json" },
  });
  expect(statusResponse.status()).toBe(200);
  expect(statusResponse.headers()["cache-control"]).toMatch(/no-store/u);
  const fixtureStatus = (await statusResponse.json()) as Record<string, unknown>;
  expect(fixtureStatus).toMatchObject({
    source_mode: "test-fixture",
    source_label: "native-e2e synthetic fixture; not provider data",
  });
  expectNoServerSecret(fixtureStatus);
  expect((await gatewayCounters(request)).calls["/api/v1/status"]).toBe(1);

  await expect
    .poll(
      async () => {
        const response = await page.request.get(putWorkspaceUrl(), {
          headers: { Accept: "application/json" },
        });
        if (response.status() !== 200) return false;
        const value = (await response.json()) as { document: unknown };
        return value.document !== null;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const initial = await page.request.get(putWorkspaceUrl(), {
    headers: { Accept: "application/json" },
  });
  expect(initial.status()).toBe(200);
  expect(initial.headers()["cache-control"]).toMatch(/no-store/u);
  const initialBody = (await initial.json()) as {
    schemaVersion: number;
    revision: string;
    document: unknown;
  };
  expectNoServerSecret(initialBody);
  expect(initialBody).toMatchObject({ schemaVersion: 1 });
  expect(initialBody.revision).toMatch(/^(0|[1-9][0-9]*)$/u);
  const etag = initial.headers().etag;
  expect(etag).toBe(`"${initialBody.revision}"`);
  if (!etag) throw new Error("Workspace GET must provide the strong ETag used by its revision.");

  const missingRevision = await page.request.put(putWorkspaceUrl(), {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: new URL(webOrigin()).origin,
    },
    data: {
      schemaVersion: 1,
      document: workspaceDocument(
        "missing-etag",
        "11111111-1111-4111-8111-000000000001",
        "22222222-2222-4222-8222-000000000001",
      ),
    },
  });
  expect(missingRevision.status()).toBe(412);

  const crossOrigin = await writeWorkspace(
    page,
    "cross-origin-must-not-save",
    etag,
    "000000000002",
    "https://attacker.invalid",
  );
  expect(crossOrigin.status()).toBe(403);
  expect(await crossOrigin.json()).toEqual({ error: "origin_rejected" });

  const race = await Promise.all([
    writeWorkspace(page, "writer-cas-a", etag, "000000000003"),
    writeWorkspace(page, "writer-cas-b", etag, "000000000004"),
  ]);
  expect(race.map((result) => result.status()).sort()).toEqual([200, 412]);
  const writerCurrent = await page.request.get(putWorkspaceUrl(), {
    headers: { Accept: "application/json" },
  });
  expect(writerCurrent.status()).toBe(200);
  const writerCurrentEtag = writerCurrent.headers().etag;
  const writerBody = (await writerCurrent.json()) as {
    revision: string;
    document: { workspaces: Array<{ name: string }> };
  };
  expectNoServerSecret(writerBody);
  expect(writerBody.revision).toBe(String(Number(initialBody.revision) + 1));
  expect(writerCurrentEtag).toBe(`"${writerBody.revision}"`);
  expect(["writer-cas-a", "writer-cas-b"]).toContain(writerBody.document.workspaces[0]?.name);
  const staleReplay = await writeWorkspace(
    page,
    "stale-replay-must-not-overwrite",
    etag,
    "000000000006",
  );
  expect(staleReplay.status()).toBe(412);
  const afterStaleReplay = await page.request.get(putWorkspaceUrl(), {
    headers: { Accept: "application/json" },
  });
  expect(
    ((await afterStaleReplay.json()) as { document: { workspaces: Array<{ name: string }> } })
      .document.workspaces[0]?.name,
  ).toBe(writerBody.document.workspaces[0]?.name);

  const secondWriterTab = await page.context().newPage();
  await secondWriterTab.goto(webOrigin(), { waitUntil: "domcontentloaded" });
  await expect(secondWriterTab.getByTestId("workspace-root")).toBeVisible();

  const readerContext: BrowserContext = await browser.newContext();
  const readerPage = await readerContext.newPage();
  try {
    await signIn(readerPage, "reader");
    const readerSnapshot = await readerPage.request.get(putWorkspaceUrl(), {
      headers: {
        Accept: "application/json",
        "X-Auth-Issuer": "https://attacker.invalid",
        "X-Auth-Subject": "writer",
        "X-Workspace-Owner": "writer",
        "X-Storage-Partition": "opaque-writer-cache-partition",
      },
    });
    expect(readerSnapshot.status()).toBe(200);
    const readerBody = (await readerSnapshot.json()) as { document: unknown };
    expect(readerBody.document).toBeNull();
    expectNoServerSecret(readerBody);

    const readerPortfolios = await readerPage.request.get(
      new URL("/api/portfolios", webOrigin()).toString(),
      {
        headers: {
          Accept: "application/json",
          "X-Auth-Issuer": "https://attacker.invalid",
          "X-Auth-Subject": "writer",
          "X-Workspace-Owner": "writer",
        },
      },
    );
    expect(readerPortfolios.status()).toBe(200);
    const readerPortfolioBody = await readerPortfolios.json();
    expect(readerPortfolioBody).toEqual([]);
    expectNoServerSecret(readerPortfolioBody);
    const foreignPositions = await readerPage.request.get(
      new URL(`/api/portfolios/${portfolioRecord.id}/positions`, webOrigin()).toString(),
      {
        headers: { Accept: "application/json", "X-Workspace-Owner": "writer" },
      },
    );
    expect(foreignPositions.status()).toBe(404);
    const foreignPositionsBody = await foreignPositions.json();
    expect(foreignPositionsBody).toEqual({ error: "portfolio_not_found" });
    expectNoServerSecret(foreignPositionsBody);

    await resetGatewayCounters(request);
    const readerQuote = await readerPage.request.get(
      new URL("/api/quotes?symbols=SPY", webOrigin()).toString(),
      {
        headers: { Accept: "application/json" },
      },
    );
    expect(readerQuote.status()).toBe(200);
    const readerQuoteBody = await readerQuote.json();
    expect(readerQuoteBody).toMatchObject({ feed: "fixture", source_mode: "test-fixture" });
    expectNoServerSecret(readerQuoteBody);
    expect((await gatewayCounters(request)).calls["/api/v1/stocks/snapshots"]).toBe(1);

    await resetGatewayCounters(request);
    const deniedPreview = await readerPage.request.post(
      new URL("/api/eqo/orders/preview", webOrigin()).toString(),
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: appOrigin,
        },
        data: {},
      },
    );
    expect(deniedPreview.status()).toBe(403);
    expect(await deniedPreview.json()).toEqual({ error: "forbidden" });
    const deniedAi = await readerPage.request.post(
      new URL("/api/research/ai", webOrigin()).toString(),
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: appOrigin,
        },
        data: { messages: [{ role: "user", content: "must not reach an external AI provider" }] },
      },
    );
    expect(deniedAi.status()).toBe(403);
    expect(await deniedAi.json()).toEqual({ error: "forbidden" });
    expect((await gatewayCounters(request)).calls["/api/v1/orders/preview"] ?? 0).toBe(0);

    for (const path of [
      "/api/eqo/research/predictions/run-private-acceptance",
      "/api/eqo/engine/status",
      "/api/eqo/engine/preview",
    ]) {
      const deniedPrivateRead = await readerPage.request.get(
        new URL(path, webOrigin()).toString(),
        {
          headers: { Accept: "application/json" },
        },
      );
      expect(deniedPrivateRead.status(), path).toBe(403);
      expect(deniedPrivateRead.headers()["cache-control"], path).toMatch(/no-store/u);
      expectNoServerSecret(await deniedPrivateRead.json());
    }

    const readerWrite = await writeWorkspace(
      readerPage,
      "reader-must-not-write",
      readerSnapshot.headers().etag ?? '"0"',
      "000000000005",
    );
    expect(readerWrite.status()).toBe(403);
    expect(JSON.stringify(readerBody)).not.toContain("writer-cas");

    await signOut(page);
    // The second tab must react to the signed-out broadcast itself. Reloading
    // here would hide a broken cross-tab cache/session boundary.
    await expect(secondWriterTab.getByTestId("access-state")).toContainText(
      "Sign in to open your workspace",
    );

    await signIn(page, "reader");
    const switchedReaderSnapshot = await page.request.get(putWorkspaceUrl(), {
      headers: { Accept: "application/json" },
    });
    expect(switchedReaderSnapshot.status()).toBe(200);
    expect(((await switchedReaderSnapshot.json()) as { document: unknown }).document).toBeNull();
    await expect(page.locator("body")).not.toContainText(/writer-cas-[ab]/u);
    expect(unexpectedBrowserRequests).toEqual([]);
  } finally {
    await readerContext.close();
  }
});
