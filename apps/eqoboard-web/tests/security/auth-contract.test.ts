import { describe, expect, it } from "vitest";
import { isPermission, PERMISSIONS, type AuthUiSnapshot } from "../../lib/contracts/auth";

describe("browser auth projection contract", () => {
  it("accepts only the closed permission vocabulary", () => {
    for (const permission of PERMISSIONS) expect(isPermission(permission)).toBe(true);
    for (const forged of ["admin", "broker:execute", "orders:submit", "workspace:owner", null, {}]) {
      expect(isPermission(forged)).toBe(false);
    }
  });

  it("keeps unauthenticated browser state free of identity and credential fields", () => {
    const snapshot: AuthUiSnapshot = {
      status: "sign-in-required",
      authenticated: false,
      displayName: null,
      permissions: [],
      storagePartition: null,
    };

    expect(Object.keys(snapshot).sort()).toEqual([
      "authenticated",
      "displayName",
      "permissions",
      "status",
      "storagePartition",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/token|issuer|subject|role|owner|secret/i);
  });
});
