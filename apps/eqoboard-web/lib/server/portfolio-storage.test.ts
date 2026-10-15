import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { default: Database } = await import("better-sqlite3");
const {
  calculatePortfolioPositions,
  createPortfolioRecord,
  createPortfolioTransaction,
  deletePortfolioRecord,
  deletePortfolioTransaction,
  listPortfolioRecords,
  listPortfolioTransactions,
} = await import("./portfolio-storage");

const ownerA = "a".repeat(64);
const ownerB = "b".repeat(64);

describe("manual portfolio ledger storage", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE portfolio_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_key, name)
      );
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER NOT NULL REFERENCES portfolio_records(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
        quantity REAL NOT NULL CHECK(quantity > 0),
        price REAL NOT NULL CHECK(price >= 0),
        executed_at TEXT NOT NULL
      );
    `);
  });

  afterEach(() => db.close());

  it("keeps same-named manual ledgers separate by owner and hides foreign rows", () => {
    const first = createPortfolioRecord(db, ownerA, "Main");
    const second = createPortfolioRecord(db, ownerB, "Main");
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    expect(listPortfolioRecords(db, ownerA)).toHaveLength(1);
    expect(listPortfolioRecords(db, ownerB)).toHaveLength(1);
    if (first.kind !== "ok") return;
    expect(listPortfolioTransactions(db, first.value.id, ownerB)).toEqual({ kind: "not-found" });
    expect(deletePortfolioRecord(db, first.value.id, ownerB)).toBe(false);
  });

  it("preserves manual transaction values, calculates average cost, and rejects oversells", () => {
    const created = createPortfolioRecord(db, ownerA, "Ledger");
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;
    const id = created.value.id;
    const bought = createPortfolioTransaction(db, id, ownerA, {
      symbol: "SPY",
      side: "BUY",
      quantity: 1,
      price: 10,
      executed_at: "2026-10-01T00:00:00.000Z",
    });
    expect(bought.kind).toBe("ok");
    createPortfolioTransaction(db, id, ownerA, {
      symbol: "SPY",
      side: "BUY",
      quantity: 3,
      price: 20,
      executed_at: "2026-10-02T00:00:00.000Z",
    });
    const sold = createPortfolioTransaction(db, id, ownerA, {
      symbol: "SPY",
      side: "SELL",
      quantity: 1,
      price: 30,
      executed_at: "2026-10-03T00:00:00.000Z",
    });
    expect(sold.kind).toBe("ok");
    expect(
      createPortfolioTransaction(db, id, ownerA, {
        symbol: "SPY",
        side: "SELL",
        quantity: 4,
        price: 40,
        executed_at: "2026-10-04T00:00:00.000Z",
      }),
    ).toEqual({ kind: "conflict" });
    expect(calculatePortfolioPositions(db, id, ownerA)).toEqual({
      kind: "ok",
      value: [{ symbol: "SPY", quantity: 3, avgCost: 17.5, realizedPnl: 12.5 }],
    });
    if (bought.kind !== "ok") return;
    expect(deletePortfolioTransaction(db, id, bought.value.id, ownerB)).toEqual({
      kind: "not-found",
    });
    expect(deletePortfolioTransaction(db, id, Number.MAX_SAFE_INTEGER, ownerA)).toEqual({
      kind: "not-found",
    });
    expect(deletePortfolioTransaction(db, id, bought.value.id, ownerA)).toEqual({
      kind: "ok",
      value: undefined,
    });
  });
});
