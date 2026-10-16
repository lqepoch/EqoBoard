import { describe, expect, it } from "vitest";
import { allowlistedRoles, permissionsForRoles } from "./permissions";

describe("verified OIDC role projection", () => {
  it("keeps only the existing allowlisted roles and closed permissions", () => {
    const roles = allowlistedRoles([
      "eqoboard-market-reader",
      "eqoboard-order-reviewer",
      "admin",
      "eqoboard-market-reader",
    ]);
    expect(roles).toEqual(["eqoboard-market-reader", "eqoboard-order-reviewer"]);
    expect(permissionsForRoles(roles)).toEqual([
      "market:read",
      "market:stream",
      "market:subscribe",
      "orders:preview",
      "research:read",
      "workspace:read",
    ]);
  });

  it("does not infer the unassigned AI permission from reader roles", () => {
    expect(permissionsForRoles(["eqoboard-market-reader"])).not.toContain("research:ai");
  });
});
