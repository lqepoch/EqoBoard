import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const YFINANCE_DAILY_QUERY =
  "symbols=SPY&asset_class=stock&start_utc=2026-01-01T00%3A00%3A00.000Z&end_utc=2026-01-02T00%3A00%3A00.000Z&adjustment=adjusted";

export type MdpFixtureCounters = Readonly<{
  calls: Readonly<Record<string, number>>;
  acceptedDelegations: number;
  rejectedDelegations: number;
  fixture: string;
}>;

export type GatewayFixtureCounters = Readonly<{ calls: Readonly<Record<string, number>> }>;

export type MockIdentity = "reader" | "writer" | "workspace-only";

function requiredOrigin(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} must be supplied by the production Compose E2E helper.`);
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(`${name} must be a plain HTTP fixture origin.`);
  }
  return parsed.origin;
}

export function terminalWebOrigin(): string {
  const origin = requiredOrigin("E2E_WEB_ORIGIN");
  if (new URL(origin).hostname !== "127.0.0.1") {
    throw new Error("E2E_WEB_ORIGIN must use the approved 127.0.0.1 terminal hostname.");
  }
  return origin;
}

export function researchWebOrigin(): string {
  const origin = requiredOrigin("E2E_RESEARCH_WEB_ORIGIN");
  if (new URL(origin).hostname !== "localhost" || new URL(origin).port !== "3441") {
    throw new Error(
      "E2E_RESEARCH_WEB_ORIGIN must use the approved localhost research hostname and port.",
    );
  }
  return origin;
}

function mdpControlOrigin(): string {
  return requiredOrigin("E2E_MDP_FIXTURE_CONTROL_ORIGIN");
}

function gatewayControlOrigin(): string {
  return requiredOrigin("E2E_FIXTURE_CONTROL_ORIGIN");
}

export async function resetGatewayFixtureCounters(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    new URL("/__test/counters/reset", gatewayControlOrigin()).toString(),
  );
  expect(response.status()).toBe(200);
}

export async function readGatewayFixtureCounters(
  request: APIRequestContext,
): Promise<GatewayFixtureCounters> {
  const response = await request.get(
    new URL("/__test/counters", gatewayControlOrigin()).toString(),
  );
  expect(response.status()).toBe(200);
  const value = (await response.json()) as unknown;
  expect(value).toMatchObject({ calls: expect.any(Object) });
  return value as GatewayFixtureCounters;
}

export async function resetMdpFixtureCounters(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    new URL("/__test/counters/reset", mdpControlOrigin()).toString(),
  );
  expect(response.status()).toBe(200);
}

export async function readMdpFixtureCounters(
  request: APIRequestContext,
): Promise<MdpFixtureCounters> {
  const response = await request.get(new URL("/__test/counters", mdpControlOrigin()).toString());
  expect(response.status()).toBe(200);
  const value = (await response.json()) as unknown;
  expect(value).toMatchObject({
    calls: expect.any(Object),
    acceptedDelegations: expect.any(Number),
    rejectedDelegations: expect.any(Number),
    fixture: "native-e2e synthetic fixture; not provider data",
  });
  return value as MdpFixtureCounters;
}

export async function signInAt(
  page: Page,
  origin: string,
  identity: MockIdentity,
  path: string,
): Promise<void> {
  await page.goto(new URL(path, origin).toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("sign-in-button").click();
  const selector =
    identity === "workspace-only" ? "mock-login-workspace-only" : `mock-login-${identity}`;
  await page.getByTestId(selector).click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
}
