import { test } from "node:test";
import assert from "node:assert/strict";
import { localAccessOrigin, localRequestAllowed, localScopes } from "../apps/openterminal/web/lib/local-access";

test("local access is explicit, terminal-only and bound to a loopback origin", () => {
  const env = { EQO_LOCAL_ACCESS: "true", EQO_LOCAL_BIND: "127.0.0.1",
    EQO_PUBLIC_ORIGIN: "http://localhost:3000", NEXTAUTH_URL: "http://localhost:3000" };
  assert.equal(localAccessOrigin(env), env.EQO_PUBLIC_ORIGIN);
  for (const extra of [{ EQO_LOCAL_ACCESS: "false" }, { EQO_LOCAL_BIND: "0.0.0.0" },
    { EQO_BFF_MODE: "research" }, { EQO_PUBLIC_ORIGIN: "http://evil.test" },
    { NEXTAUTH_URL: "http://localhost:4000" }]) {
    assert.equal(localAccessOrigin({ ...env, ...extra }), null);
  }
});

test("local requests reject cross-origin requests and foreign hostnames", () => {
  const before = { ...process.env };
  Object.assign(process.env, { EQO_LOCAL_ACCESS: "true", EQO_LOCAL_BIND: "127.0.0.1",
    EQO_PUBLIC_ORIGIN: "http://localhost:3000", NEXTAUTH_URL: "http://localhost:3000" });
  delete process.env.EQO_BFF_MODE;
  try {
    const request = (headers = {}) => new Request("http://localhost:3000/api/eqo/status", {
      headers: { host: "localhost:3000", ...headers },
    });
    assert.equal(localRequestAllowed(request()), true);
    assert.equal(localRequestAllowed(request({ "sec-fetch-site": "none" })), true);
    assert.equal(localRequestAllowed(request({ host: "evil.test" })), false);
    assert.equal(localRequestAllowed(request({ "x-forwarded-host": "evil.test" })), false);
    assert.equal(localRequestAllowed(request({ "x-forwarded-host": "localhost:3000" })), true);
    assert.equal(localRequestAllowed(request({ origin: "http://evil.test" })), false);
    assert.equal(localRequestAllowed(request({ "sec-fetch-site": "cross-site" })), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});

test("workstation grants requested preview, Paper and private research; no Live scope", () => {
  const scopes = localScopes();
  for (const scope of ["orders:preview", "paper:submit", "research:private-read"])
    assert.ok(scopes.includes(scope as typeof scopes[number]));
  assert.equal(scopes.some(scope => scope.startsWith("live:")), false);
  assert.equal(scopes.includes("engine:offline-read"), false);
});
