import { describe, expect, it } from "vitest";
import { isWidgetActionId, WIDGET_ACTION_IDS } from "./actions";

describe("closed widget action identifiers", () => {
  it("allows only static host actions, including manual ledger mutations", () => {
    expect(WIDGET_ACTION_IDS).toEqual([
      "research.ai",
      "orders.preview.vertical",
      "portfolio.create",
      "portfolio.delete",
      "portfolio.transaction.create",
      "portfolio.transaction.delete",
    ]);
    expect(WIDGET_ACTION_IDS.every(isWidgetActionId)).toBe(true);
    expect(isWidgetActionId("orders.submit")).toBe(false);
    expect(isWidgetActionId("portfolio.arbitrary-path")).toBe(false);
  });
});
