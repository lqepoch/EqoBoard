import { expect, test } from "@playwright/test";

type CounterSnapshot = Readonly<{ calls: Readonly<Record<string, number>> }>;

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

test("@api signed OIDC opens the fixed stream route with a bounded delegation and no market events", async ({
  page,
  request,
}) => {
  const appOrigin = new URL(webOrigin()).origin;
  const oidcOrigin = "http://native-mock-oidc:4450";
  const unexpectedBrowserRequests: string[] = [];
  const streamResponses: number[] = [];
  page.on("request", (browserRequest) => {
    const origin = new URL(browserRequest.url()).origin;
    if (origin !== appOrigin && origin !== oidcOrigin)
      unexpectedBrowserRequests.push(browserRequest.url());
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/eqo/live")
      streamResponses.push(response.status());
  });

  const controlOrigin = fixtureControlOrigin();
  const reset = await request.post(new URL("/__test/counters/reset", controlOrigin).toString());
  expect(reset.status()).toBe(200);

  await page.goto(webOrigin(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("sign-in-button").click();
  const chooser = page.getByTestId("mock-login-reader");
  await expect(chooser).toBeVisible();
  const streamResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).origin === appOrigin &&
      new URL(response.url()).pathname === "/api/eqo/live",
  );
  await chooser.click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await expect(page.getByTestId("workspace-root")).toBeVisible();

  const response = await streamResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^text\/event-stream(?:;|$)/iu);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["x-accel-buffering"]).toBe("no");

  const countersResponse = await request.get(new URL("/__test/counters", controlOrigin).toString());
  expect(countersResponse.status()).toBe(200);
  const counters = (await countersResponse.json()) as CounterSnapshot;
  expect(counters.calls["/api/v1/stream/sse"]).toBe(1);
  expect(streamResponses).toEqual([200]);

  const invalidQuery = await page.request.get(
    new URL("/api/eqo/live?symbol=SPY", webOrigin()).toString(),
    {
      headers: { Accept: "application/json" },
    },
  );
  expect(invalidQuery.status()).toBe(400);
  expect(invalidQuery.headers()["cache-control"]).toMatch(/no-store/u);
  expect(await invalidQuery.json()).toEqual({ error: "invalid_request" });

  const afterInvalidQuery = await request.get(
    new URL("/__test/counters", controlOrigin).toString(),
  );
  const finalCounters = (await afterInvalidQuery.json()) as CounterSnapshot;
  expect(finalCounters.calls["/api/v1/stream/sse"]).toBe(1);
  expect(unexpectedBrowserRequests).toEqual([]);
});
