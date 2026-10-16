import { describe, expect, it } from "vitest";
import { researchWidgetRegistrations } from "./registrations";

describe("native Yahoo research registration", () => {
  it("keeps the terminal entry as a portal card and scopes observations to the Yahoo read", () => {
    const registration = researchWidgetRegistrations.find(
      (item) => item.manifest.id === "eqoboard.research.daily-history",
    );
    expect(registration).toBeDefined();
    expect(registration?.manifest.requiredPermissions).toEqual([]);
    expect(registration?.allowedReadOperations).toEqual(["research.yahoo.daily"]);
    expect(registration?.allowedActions).toEqual([]);
    expect(registration?.provenance.sourceCommit).toBe("fea1e952add7a11e799d6f9f198ddcee47fd12b6");
  });
});
