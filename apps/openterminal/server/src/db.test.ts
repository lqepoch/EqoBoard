import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// db.ts reads DATA_DIR at import time and opens a real sqlite file there, so
// point it at a throwaway directory instead of the app's real data/ folder.
let tmpDir: string;
let db: (typeof import("./db.js"))["db"];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bloomber-db-test-"));
  process.env.DATA_DIR = tmpDir;
  const legacy = new Database(join(tmpDir, "terminal.db"));
  legacy.exec(`
    CREATE TABLE portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
      quantity REAL NOT NULL CHECK (quantity > 0),
      price REAL NOT NULL CHECK (price >= 0),
      executed_at TEXT NOT NULL
    );
    INSERT INTO portfolios (id, name, created_at) VALUES (17, 'Main', '2025-01-01');
    INSERT INTO transactions (id, portfolio_id, symbol, side, quantity, price, executed_at)
      VALUES (23, 17, 'QQQ', 'BUY', 1, 100, '2025-01-02');
  `);
  legacy.close();
  ({ db } = await import("./db.js"));
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("db foreign keys", () => {
  it("migrates legacy portfolios without reassigning or dropping related rows", () => {
    expect(db.prepare("SELECT id, owner_sub FROM portfolios WHERE id = 17").get()).toEqual({
      id: 17,
      owner_sub: "local",
    });
    expect(db.prepare("SELECT id, portfolio_id FROM transactions WHERE id = 23").get()).toEqual({
      id: 23,
      portfolio_id: 17,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("allows identical portfolio names for separate owners", () => {
    expect(() => db.prepare("INSERT INTO portfolios (name, owner_sub) VALUES (?, ?)").run("Main", "issuer-a\0user-a")).not.toThrow();
    expect(() => db.prepare("INSERT INTO portfolios (name, owner_sub) VALUES (?, ?)").run("Main", "issuer-b\0user-a")).not.toThrow();
    expect(() => db.prepare("INSERT INTO portfolios (name, owner_sub) VALUES (?, ?)").run("Main", "issuer-a\0user-a")).toThrow(/UNIQUE constraint failed/);
  });

  it("enforces the foreign key on transactions.portfolio_id", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(999999, "AAPL", "BUY", 1, 100, "2026-01-01T00:00:00Z")
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("still allows inserts against a real portfolio", () => {
    const portfolio = db.prepare("SELECT id FROM portfolios LIMIT 1").get() as { id: number };
    expect(() =>
      db
        .prepare(
          "INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(portfolio.id, "AAPL", "BUY", 1, 100, "2026-01-01T00:00:00Z")
    ).not.toThrow();
  });
});
