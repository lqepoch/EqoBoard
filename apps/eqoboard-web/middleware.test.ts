import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { contentSecurityPolicy, middleware } from "./middleware";

describe("request nonce and Content-Security-Policy", () => {
  it("forwards a fresh nonce and identical CSP to App Router and the browser response", () => {
    const first = middleware(new NextRequest("https://terminal.example.test/"));
    const second = middleware(new NextRequest("https://terminal.example.test/workspace"));
    const firstCsp = first.headers.get("content-security-policy");
    const secondCsp = second.headers.get("content-security-policy");
    const firstNonce = first.headers.get("x-middleware-request-x-nonce");
    const secondNonce = second.headers.get("x-middleware-request-x-nonce");

    expect(firstNonce).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(secondNonce).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(secondNonce).not.toBe(firstNonce);
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(firstCsp);
    expect(second.headers.get("x-middleware-request-content-security-policy")).toBe(secondCsp);
    expect(firstCsp).toContain(`'nonce-${firstNonce}'`);
    expect(secondCsp).toContain(`'nonce-${secondNonce}'`);
    expect(first.headers.get("x-nonce")).toBeNull();

    const productionCsp = contentSecurityPolicy("YWJjZA==", true);
    expect(productionCsp).toContain("'strict-dynamic'");
    expect(productionCsp).not.toContain("'unsafe-eval'");
    expect(productionCsp).not.toContain("script-src 'unsafe-inline'");
  });

  it("keeps API responses no-store without returning nonce or cookie material", () => {
    const response = middleware(
      new NextRequest("https://terminal.example.test/api/workspaces", {
        headers: { cookie: "eqoboard.session-token=private" },
      }),
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-nonce")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeNull();
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBeNull();
  });
});
