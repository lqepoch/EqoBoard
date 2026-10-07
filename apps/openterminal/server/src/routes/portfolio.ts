import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";

export const portfolioRouter = Router();

function getOwner(req: import("express").Request, res: import("express").Response): string | null {
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

portfolioRouter.get("/", (req, res) => {
  const owner = getOwner(req, res);
  if (!owner) return;
  res.json(db.prepare("SELECT id, name, created_at FROM portfolios WHERE owner_sub = ? ORDER BY id").all(owner));
});

portfolioRouter.post("/", (req, res) => {
  const owner = getOwner(req, res);
  if (!owner) return;
  const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    const info = db.prepare("INSERT INTO portfolios (name, owner_sub) VALUES (?, ?)").run(parsed.data.name, owner);
    res.status(201).json({ id: info.lastInsertRowid, name: parsed.data.name });
  } catch {
    res.status(409).json({ error: "portfolio name already exists" });
  }
});

portfolioRouter.delete("/:id", (req, res) => {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) return res.status(404).json({ error: "portfolio_not_found" });
  db.prepare("DELETE FROM portfolios WHERE id = ? AND owner_sub = ?").run(req.params.id, owner);
  res.status(204).end();
});

const txSchema = z.object({
  symbol: z.string().min(1).max(12).transform((s) => s.toUpperCase()),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().positive(),
  price: z.number().nonnegative(),
  executed_at: z.string(),
});

portfolioRouter.get("/:id/transactions", (req, res) => {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) return res.status(404).json({ error: "portfolio_not_found" });
  res.json(
    db
      .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at DESC, id DESC")
      .all(req.params.id)
  );
});

portfolioRouter.post("/:id/transactions", (req, res) => {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) return res.status(404).json({ error: "portfolio_not_found" });
  const parsed = txSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const t = parsed.data;
  try {
    const info = db
      .prepare(
        "INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(req.params.id, t.symbol, t.side, t.quantity, t.price, t.executed_at);
    res.status(201).json({ id: info.lastInsertRowid, ...t });
  } catch {
    res.status(404).json({ error: "portfolio not found" });
  }
});

portfolioRouter.delete("/:id/transactions/:txId", (req, res) => {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) return res.status(404).json({ error: "portfolio_not_found" });
  db.prepare("DELETE FROM transactions WHERE id = ? AND portfolio_id = ?").run(req.params.txId, req.params.id);
  res.status(204).end();
});

/** Aggregated positions with average cost and realized PnL (FIFO-free, average-cost method). */
portfolioRouter.get("/:id/positions", (req, res) => {
  const owner = getOwner(req, res);
  if (!owner) return;
  if (!ownsPortfolio(req.params.id, owner)) return res.status(404).json({ error: "portfolio_not_found" });
  const txs = db
    .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at, id")
    .all(req.params.id) as Array<{ symbol: string; side: string; quantity: number; price: number }>;

  const positions = new Map<string, { qty: number; avgCost: number; realizedPnl: number }>();
  for (const tx of txs) {
    let p = positions.get(tx.symbol);
    if (!p) {
      p = { qty: 0, avgCost: 0, realizedPnl: 0 };
      positions.set(tx.symbol, p);
    }
    if (tx.side === "BUY") {
      const totalCost = p.avgCost * p.qty + tx.price * tx.quantity;
      p.qty += tx.quantity;
      p.avgCost = p.qty > 0 ? totalCost / p.qty : 0;
    } else {
      const sold = Math.min(tx.quantity, p.qty);
      p.realizedPnl += (tx.price - p.avgCost) * sold;
      p.qty -= sold;
      if (p.qty === 0) p.avgCost = 0;
    }
  }
  res.json(
    [...positions.entries()]
      .filter(([, p]) => p.qty > 0 || p.realizedPnl !== 0)
      .map(([symbol, p]) => ({ symbol, quantity: p.qty, avgCost: p.avgCost, realizedPnl: p.realizedPnl }))
  );
});
