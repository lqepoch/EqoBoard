import "server-only";

import type Database from "better-sqlite3";

export type PortfolioRecord = Readonly<{ id: number; name: string; created_at: string }>;
export type PortfolioTransaction = Readonly<{
  id: number;
  portfolio_id: number;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  executed_at: string;
}>;
export type PortfolioPosition = Readonly<{
  symbol: string;
  quantity: number;
  avgCost: number;
  realizedPnl: number;
}>;
export type PortfolioResult<T> =
  | Readonly<{ kind: "ok"; value: T }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "too-many" }>;

const OWNER_KEY = /^[0-9a-f]{64}$/u;
const MAX_PORTFOLIOS_PER_OWNER = 100;
const MAX_TRANSACTIONS_PER_PORTFOLIO = 10_000;

function requireOwnerKey(ownerKey: string): void {
  if (!OWNER_KEY.test(ownerKey)) throw new TypeError("Invalid portfolio owner key.");
}

function ownerPortfolioExists(db: Database.Database, portfolioId: number, ownerKey: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM portfolio_records WHERE id = ? AND owner_key = ?",
  ).get(portfolioId, ownerKey));
}

function transactionsFor(db: Database.Database, portfolioId: number, chronological = false): PortfolioTransaction[] {
  const order = chronological ? "executed_at ASC, id ASC" : "executed_at DESC, id DESC";
  return db.prepare(`
    SELECT id, portfolio_id, symbol, side, quantity, price, executed_at
    FROM transactions WHERE portfolio_id = ? ORDER BY ${order}
  `).all(portfolioId) as PortfolioTransaction[];
}

export function listPortfolioRecords(db: Database.Database, ownerKey: string): readonly PortfolioRecord[] {
  requireOwnerKey(ownerKey);
  return db.prepare(`
    SELECT id, name, created_at FROM portfolio_records WHERE owner_key = ? ORDER BY id
  `).all(ownerKey) as PortfolioRecord[];
}

export function createPortfolioRecord(
  db: Database.Database,
  ownerKey: string,
  name: string,
): PortfolioResult<PortfolioRecord> {
  requireOwnerKey(ownerKey);
  const create = db.transaction((): PortfolioResult<PortfolioRecord> => {
    const count = db.prepare("SELECT count(*) AS count FROM portfolio_records WHERE owner_key = ?")
      .get(ownerKey) as { count: number };
    if (count.count >= MAX_PORTFOLIOS_PER_OWNER) return { kind: "conflict" };
    const result = db.prepare(
      "INSERT INTO portfolio_records (name, owner_key) VALUES (?, ?)",
    ).run(name, ownerKey);
    const id = Number(result.lastInsertRowid);
    const record = db.prepare(
      "SELECT id, name, created_at FROM portfolio_records WHERE id = ? AND owner_key = ?",
    ).get(id, ownerKey) as PortfolioRecord | undefined;
    return record ? { kind: "ok", value: record } : { kind: "not-found" };
  });
  try {
    return create.immediate();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "SQLITE_CONSTRAINT_UNIQUE") return { kind: "conflict" };
    throw error;
  }
}

export function deletePortfolioRecord(db: Database.Database, portfolioId: number, ownerKey: string): boolean {
  requireOwnerKey(ownerKey);
  return db.prepare("DELETE FROM portfolio_records WHERE id = ? AND owner_key = ?").run(portfolioId, ownerKey).changes === 1;
}

export function listPortfolioTransactions(
  db: Database.Database,
  portfolioId: number,
  ownerKey: string,
): PortfolioResult<readonly PortfolioTransaction[]> {
  requireOwnerKey(ownerKey);
  if (!ownerPortfolioExists(db, portfolioId, ownerKey)) return { kind: "not-found" };
  const count = db.prepare("SELECT count(*) AS count FROM transactions WHERE portfolio_id = ?")
    .get(portfolioId) as { count: number };
  if (count.count > MAX_TRANSACTIONS_PER_PORTFOLIO) return { kind: "too-many" };
  return { kind: "ok", value: transactionsFor(db, portfolioId) };
}

export function createPortfolioTransaction(
  db: Database.Database,
  portfolioId: number,
  ownerKey: string,
  transaction: Omit<PortfolioTransaction, "id" | "portfolio_id">,
): PortfolioResult<PortfolioTransaction> {
  requireOwnerKey(ownerKey);
  const save = db.transaction((): PortfolioResult<PortfolioTransaction> => {
    if (!ownerPortfolioExists(db, portfolioId, ownerKey)) return { kind: "not-found" };
    const count = db.prepare("SELECT count(*) AS count FROM transactions WHERE portfolio_id = ?")
      .get(portfolioId) as { count: number };
    if (count.count >= MAX_TRANSACTIONS_PER_PORTFOLIO) return { kind: "too-many" };
    if (transaction.side === "SELL") {
      const rows = db.prepare(`
        SELECT side, quantity, executed_at, id FROM transactions
        WHERE portfolio_id = ? AND symbol = ? ORDER BY executed_at, id
      `).all(portfolioId, transaction.symbol) as Array<{ side: string; quantity: number; executed_at: string; id: number }>;
      rows.push({ ...transaction, id: Number.MAX_SAFE_INTEGER });
      rows.sort((left, right) => left.executed_at.localeCompare(right.executed_at) || left.id - right.id);
      let available = 0;
      for (const row of rows) {
        if (row.side === "BUY") available += row.quantity;
        else {
          const tolerance = Number.EPSILON * Math.max(1, available);
          if (row.quantity > available + tolerance) return { kind: "conflict" };
          available = Math.max(0, available - row.quantity);
        }
      }
    }
    const inserted = db.prepare(`
      INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(portfolioId, transaction.symbol, transaction.side, transaction.quantity, transaction.price, transaction.executed_at);
    const row = db.prepare(`
      SELECT id, portfolio_id, symbol, side, quantity, price, executed_at
      FROM transactions WHERE id = ? AND portfolio_id = ?
    `).get(Number(inserted.lastInsertRowid), portfolioId) as PortfolioTransaction | undefined;
    return row ? { kind: "ok", value: row } : { kind: "not-found" };
  });
  return save.immediate();
}

export function deletePortfolioTransaction(
  db: Database.Database,
  portfolioId: number,
  transactionId: number,
  ownerKey: string,
): PortfolioResult<void> {
  requireOwnerKey(ownerKey);
  if (!ownerPortfolioExists(db, portfolioId, ownerKey)) return { kind: "not-found" };
  const count = db.prepare("SELECT count(*) AS count FROM transactions WHERE portfolio_id = ?")
    .get(portfolioId) as { count: number };
  if (count.count > MAX_TRANSACTIONS_PER_PORTFOLIO) return { kind: "too-many" };
  const deleted = db.prepare("DELETE FROM transactions WHERE id = ? AND portfolio_id = ?")
    .run(transactionId, portfolioId);
  return deleted.changes === 1 ? { kind: "ok", value: undefined } : { kind: "not-found" };
}

export function calculatePortfolioPositions(
  db: Database.Database,
  portfolioId: number,
  ownerKey: string,
): PortfolioResult<readonly PortfolioPosition[]> {
  requireOwnerKey(ownerKey);
  if (!ownerPortfolioExists(db, portfolioId, ownerKey)) return { kind: "not-found" };
  const positions = new Map<string, { quantity: number; avgCost: number; realizedPnl: number }>();
  for (const transaction of transactionsFor(db, portfolioId, true)) {
    const position = positions.get(transaction.symbol) ?? { quantity: 0, avgCost: 0, realizedPnl: 0 };
    if (transaction.side === "BUY") {
      const totalCost = position.avgCost * position.quantity + transaction.price * transaction.quantity;
      position.quantity += transaction.quantity;
      position.avgCost = position.quantity > 0 ? totalCost / position.quantity : 0;
    } else {
      const sold = Math.min(transaction.quantity, position.quantity);
      position.realizedPnl += (transaction.price - position.avgCost) * sold;
      position.quantity -= sold;
      if (position.quantity <= Number.EPSILON) {
        position.quantity = 0;
        position.avgCost = 0;
      }
    }
    positions.set(transaction.symbol, position);
  }
  return {
    kind: "ok",
    value: [...positions.entries()]
      .filter(([, position]) => position.quantity > 0 || position.realizedPnl !== 0)
      .map(([symbol, position]) => ({ symbol, ...position })),
  };
}

export function parsePortfolioId(value: string): number | null {
  if (!/^[1-9][0-9]{0,14}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
