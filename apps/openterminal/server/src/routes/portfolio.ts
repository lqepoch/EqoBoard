import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db.js";

type PortfolioRateLimitOptions = {
  windowMs?: number;
  ownerLimit?: number;
  serviceLimit?: number;
};

const txSchema = z.object({
  symbol: z.string().min(1).max(12).transform((s) => s.toUpperCase()),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().positive(),
  price: z.number().nonnegative(),
  executed_at: z.string(),
});

function getOwner(req: Request, res: Response): string | null {
  const owner = req.verifiedPrincipal?.ownerId;
  if (!owner) {
    res.status(401).json({ error: "authentication_required" });
    return null;
  }
  return owner;
}

function ownsPortfolio(portfolioId: string, owner: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM portfolios WHERE id = ? AND owner_sub = ?").get(portfolioId, owner));
}

function listPortfolios(req: Request, res: Response): void {
  const owner = getOwner(req, res);
  if (!owner) return;
  res.json(db.prepare("SELECT id, name, created_at FROM portfolios WHERE owner_sub = ? ORDER BY id").all(owner));
}

function createPortfolio(req: Request, res: Response): void {
  const owner = getOwner(req, res);
  if (!owner) return;
  const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const info = db.prepare("INSERT INTO portfolios (name, owner_sub) VALUES (?, ?)").run(parsed.data.name, owner);
    res.status(201).json({ id: info.lastInsertRowid, name: parsed.data.name });
  } catch {
    res.status(409).json({ error: "portfolio name already exists" });
  }
}

function deletePortfolio(req: Request, res: Response): void {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) {
    res.status(404).json({ error: "portfolio_not_found" });
    return;
  }
  db.prepare("DELETE FROM portfolios WHERE id = ? AND owner_sub = ?").run(req.params.id, owner);
  res.status(204).end();
}

function listTransactions(req: Request, res: Response): void {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) {
    res.status(404).json({ error: "portfolio_not_found" });
    return;
  }
  res.json(
    db
      .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at DESC, id DESC")
      .all(req.params.id)
  );
}

function createTransaction(req: Request, res: Response): void {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) {
    res.status(404).json({ error: "portfolio_not_found" });
    return;
  }
  const parsed = txSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const transaction = parsed.data;
  try {
    const info = db
      .prepare(
        "INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        req.params.id,
        transaction.symbol,
        transaction.side,
        transaction.quantity,
        transaction.price,
        transaction.executed_at
      );
    res.status(201).json({ id: info.lastInsertRowid, ...transaction });
  } catch {
    res.status(404).json({ error: "portfolio not found" });
  }
}

function deleteTransaction(req: Request, res: Response): void {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) {
    res.status(404).json({ error: "portfolio_not_found" });
    return;
  }
  db.prepare("DELETE FROM transactions WHERE id = ? AND portfolio_id = ?").run(req.params.txId, req.params.id);
  res.status(204).end();
}

/** Aggregated positions with average cost and realized PnL (FIFO-free, average-cost method). */
function listPositions(req: Request, res: Response): void {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) {
    res.status(404).json({ error: "portfolio_not_found" });
    return;
  }
  const transactions = db
    .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at, id")
    .all(req.params.id) as Array<{ symbol: string; side: string; quantity: number; price: number }>;

  const positions = new Map<string, { qty: number; avgCost: number; realizedPnl: number }>();
  for (const transaction of transactions) {
    let position = positions.get(transaction.symbol);
    if (!position) {
      position = { qty: 0, avgCost: 0, realizedPnl: 0 };
      positions.set(transaction.symbol, position);
    }
    if (transaction.side === "BUY") {
      const totalCost = position.avgCost * position.qty + transaction.price * transaction.quantity;
      position.qty += transaction.quantity;
      position.avgCost = position.qty > 0 ? totalCost / position.qty : 0;
    } else {
      const sold = Math.min(transaction.quantity, position.qty);
      position.realizedPnl += (transaction.price - position.avgCost) * sold;
      position.qty -= sold;
      if (position.qty === 0) position.avgCost = 0;
    }
  }
  res.json(
    [...positions.entries()]
      .filter(([, position]) => position.qty > 0 || position.realizedPnl !== 0)
      .map(([symbol, position]) => ({
        symbol,
        quantity: position.qty,
        avgCost: position.avgCost,
        realizedPnl: position.realizedPnl,
      }))
  );
}

export function createPortfolioRouter(options: PortfolioRateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const serviceRateLimit = rateLimit({
    windowMs,
    limit: options.serviceLimit ?? 1_200,
    keyGenerator: () => "portfolio-service",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate_limit_exceeded" },
    passOnStoreError: false,
  });
  const ownerRateLimit = rateLimit({
    windowMs,
    limit: options.ownerLimit ?? 120,
    keyGenerator: (req) => req.verifiedPrincipal?.ownerId ?? "unauthenticated",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate_limit_exceeded" },
    passOnStoreError: false,
  });
  const router = Router();

  router.get("/", serviceRateLimit, ownerRateLimit, listPortfolios);
  router.post("/", serviceRateLimit, ownerRateLimit, createPortfolio);
  router.delete("/:id", serviceRateLimit, ownerRateLimit, deletePortfolio);
  router.get("/:id/transactions", serviceRateLimit, ownerRateLimit, listTransactions);
  router.post("/:id/transactions", serviceRateLimit, ownerRateLimit, createTransaction);
  router.delete("/:id/transactions/:txId", serviceRateLimit, ownerRateLimit, deleteTransaction);
  router.get("/:id/positions", serviceRateLimit, ownerRateLimit, listPositions);

  return router;
}

export const portfolioRouter = createPortfolioRouter();
