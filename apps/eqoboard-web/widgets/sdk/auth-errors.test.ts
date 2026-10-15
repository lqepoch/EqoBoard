import { describe, expect, it } from "vitest";
import { projectWidgetAuthorization } from "./auth";
import { toWidgetRuntimeError, widgetErrorMessage } from "./errors";
import { WidgetDataReadError } from "./data";

describe("widget safe auth and error projections", () => {
  it("exposes only authenticated and closed permissions, never cache or identity metadata", () => {
    const projected = projectWidgetAuthorization({
      status: "authenticated",
      authenticated: true,
      displayName: "Private Name",
      permissions: ["market:read", "workspace:write"],
      storagePartition: "opaque-owner-cache-key",
    });
    expect(projected).toEqual({ authenticated: true, permissions: ["market:read", "workspace:write"] });
    expect(Object.keys(projected).sort()).toEqual(["authenticated", "permissions"]);
    expect(projectWidgetAuthorization({
      status: "sign-in-required",
      authenticated: false,
      displayName: null,
      permissions: [],
      storagePartition: null,
    }).permissions).toEqual([]);
  });

  it("normalizes private exception details to bounded UI messages", () => {
    const raw = new Error("provider response body with credentials");
    const safe = toWidgetRuntimeError(raw);
    expect(safe).toEqual({ code: "request-failed", retryable: true });
    expect(widgetErrorMessage(safe)).not.toContain("credentials");
    expect(toWidgetRuntimeError(new WidgetDataReadError("hidden")))
      .toEqual({ code: "cancelled", retryable: false });
    expect(toWidgetRuntimeError(new WidgetDataReadError("rate-limited", 100_000)))
      .toEqual({ code: "rate-limited", retryable: true, retryAfterMs: 60_000 });
  });

  it("does not invoke getters on untrusted thrown values", () => {
    let called = false;
    const thrown = Object.defineProperty({}, "code", {
      enumerable: true,
      get() {
        called = true;
        throw new Error("must not be read");
      },
    });
    expect(toWidgetRuntimeError(thrown)).toEqual({ code: "request-failed", retryable: true });
    expect(called).toBe(false);
  });
});

