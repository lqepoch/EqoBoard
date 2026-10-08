import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";

export const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3300";
const MOCK_OIDC_PORT = process.env.E2E_OIDC_PORT ?? "4310";
export const MOCK_OIDC_ORIGIN = process.env.E2E_OIDC_ORIGIN ?? `http://127.0.0.1:${MOCK_OIDC_PORT}`;

export async function setRoles(request: APIRequestContext, roles: string[]) {
  const response = await request.post(`${MOCK_OIDC_ORIGIN}/__test/roles`, { data: { roles } });
  expect(response.ok()).toBeTruthy();
}

export async function resetDownstream(request: APIRequestContext) {
  await expect.poll(async () => {
    const result = await metrics(request);
    return {
      activeStreams: result.gateway.activeStreams,
      gatewayInFlight: result.gateway.inFlight,
      researchInFlight: result.research.inFlight,
      mdpInFlight: result.mdp.inFlight,
      quantInFlight: result.quant.inFlight,
    };
  }, { timeout: 5_000 }).toEqual({ activeStreams: 0, gatewayInFlight: 0, researchInFlight: 0, mdpInFlight: 0, quantInFlight: 0 });
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
  const beforeLogin = await metrics(request);
  const gatewayStreamsBeforeLogin = beforeLogin.gateway.streamOpened;
  const gatewayStreamRequestsBeforeLogin = beforeLogin.gateway.requests["/api/v1/stream/sse"] ?? 0;
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

  const expectsMarketStream = roles.includes("eqoboard-market-reader");
  if (expectsMarketStream) {
    // Prove this authorized login opened a Gateway stream before navigating
    // away. Otherwise a zero-equals-zero close count could pass before a late
    // EventSource request reaches the Gateway.
    await expect.poll(async () => {
      const result = await metrics(request);
      return {
        openedAfterLogin: result.gateway.streamOpened > gatewayStreamsBeforeLogin,
        activeStreams: result.gateway.activeStreams,
      };
    }, { timeout: 5_000 }).toEqual({ openedAfterLogin: true, activeStreams: 1 });
  }

  await page.goto("/api/healthz");
  await expect.poll(async () => {
    const result = await metrics(request);
    if (!expectsMarketStream) {
      return {
        noGatewayStreamRequest: (result.gateway.requests["/api/v1/stream/sse"] ?? 0) === gatewayStreamRequestsBeforeLogin,
        noGatewayStreamOpened: result.gateway.streamOpened === gatewayStreamsBeforeLogin,
        activeStreams: result.gateway.activeStreams,
        gatewayInFlight: result.gateway.inFlight,
        researchInFlight: result.research.inFlight,
        quantInFlight: result.quant.inFlight,
      };
    }
    return {
      streamsBalanced: result.gateway.streamClosed === result.gateway.streamOpened,
      streamOpened: result.gateway.streamOpened,
      streamClosed: result.gateway.streamClosed,
      activeStreams: result.gateway.activeStreams,
      gatewayInFlight: result.gateway.inFlight,
      researchInFlight: result.research.inFlight,
      quantInFlight: result.quant.inFlight,
    };
  }, { timeout: 5_000 }).toMatchObject(expectsMarketStream ? {
    streamsBalanced: true,
    activeStreams: 0,
    gatewayInFlight: 0,
    researchInFlight: 0,
    quantInFlight: 0,
  } : {
    noGatewayStreamRequest: true,
    noGatewayStreamOpened: true,
    activeStreams: 0,
    gatewayInFlight: 0,
    researchInFlight: 0,
    quantInFlight: 0,
  });
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
