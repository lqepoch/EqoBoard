import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";

export const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3300";
export const MOCK_OIDC_ORIGIN = process.env.E2E_OIDC_ORIGIN ?? "http://127.0.0.1:4310";

export async function setRoles(request: APIRequestContext, roles: string[]) {
  const response = await request.post(`${MOCK_OIDC_ORIGIN}/__test/roles`, { data: { roles } });
  expect(response.ok()).toBeTruthy();
}

export async function resetDownstream(request: APIRequestContext) {
  await expect.poll(async () => {
    const result = await metrics(request);
    return result.gateway.activeStreams === 0 && result.gateway.inFlight === 0 && result.research.inFlight === 0;
  }, { timeout: 5_000 }).toBe(true);
  const response = await request.post(`${MOCK_OIDC_ORIGIN}/__test/reset`);
  expect(response.ok()).toBeTruthy();
}

export async function metrics(request: APIRequestContext) {
  const response = await request.get(`${MOCK_OIDC_ORIGIN}/__test/metrics`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

export async function configureMocks(request: APIRequestContext, config: Record<string, unknown>) {
  const response = await request.post(`${MOCK_OIDC_ORIGIN}/__test/config`, { data: config });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

export async function loginWithOidc(page: Page, request: APIRequestContext, roles: string[]): Promise<number> {
  await setRoles(request, roles);
  await page.goto("/");
  await page.getByRole("button", { name: /organization identity provider/i }).click();
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(session.status).toBe(200);
  expect(session.body.user.id).toBe("subject-e2e");
  expect(session.body.user.roles).toEqual(roles);
  expect(session.body.user.issuer).toBe(MOCK_OIDC_ORIGIN);
  expect(session.body.sessionExpiresAt).toBeGreaterThan(Date.now() + 1_000);
  await page.goto("/api/healthz");
  await expect.poll(async () => {
    const result = await metrics(request);
    return result.gateway.streamClosed === result.gateway.streamOpened;
  }, { timeout: 5_000 }).toBe(true);
  await resetDownstream(request);
  return session.body.sessionExpiresAt;
}

type Fixtures = {
  signInAs: (roles: string[]) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  signInAs: async ({ page, request }, use) => {
    await use(async (roles) => {
      await loginWithOidc(page, request, roles);
    });
  },
});

export { expect };
