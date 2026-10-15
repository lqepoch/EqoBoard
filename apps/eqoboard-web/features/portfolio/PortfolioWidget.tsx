"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { NativeActionMap, NativeDataOperationMap } from "@/features/data/operations";
import type {
  ManualPortfolioPositionV1,
  ManualPortfolioTransactionV1,
  ManualPortfolioV1,
} from "@/features/portfolio/contracts";
import type { MarketHostSnapshot } from "@/stores/market/market-store";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import styles from "./portfolio.module.css";

export type PortfolioWidgetConfigV1 = Readonly<{ schemaVersion: 1 }>;

type PortfolioWidgetProps = WidgetProps<
  PortfolioWidgetConfigV1,
  NativeDataOperationMap,
  Pick<NativeActionMap,
    | "portfolio.create"
    | "portfolio.delete"
    | "portfolio.transaction.create"
    | "portfolio.transaction.delete"
  >,
  MarketHostSnapshot
>;

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length <= 180) return error.message;
  return "The manual ledger request could not be completed.";
}

function localDateTimeValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatLedgerNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
}

export function PortfolioWidget({ host }: PortfolioWidgetProps) {
  const [portfolios, setPortfolios] = useState<readonly ManualPortfolioV1[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [positions, setPositions] = useState<readonly ManualPortfolioPositionV1[]>([]);
  const [transactions, setTransactions] = useState<readonly ManualPortfolioTransactionV1[]>([]);
  const [portfolioName, setPortfolioName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [executedAt, setExecutedAt] = useState(localDateTimeValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const canWrite = host.auth.authenticated && host.auth.permissions.includes("workspace:write");
  const selected = useMemo(() => portfolios.find((item) => item.id === selectedId) ?? null, [portfolios, selectedId]);

  const reloadPortfolios = useCallback(async (signal: AbortSignal) => {
    const next = await host.data.read("portfolio.list", {}, { signal });
    setPortfolios(next);
    setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
  }, [host.data]);

  useEffect(() => {
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active") return;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    lifecycle.signal.addEventListener("abort", cancel, { once: true });
    setError(null);
    void reloadPortfolios(controller.signal).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(asErrorMessage(cause));
      host.reportError({ code: "data-unavailable", retryable: true });
    });
    return () => {
      lifecycle.signal.removeEventListener("abort", cancel);
      controller.abort();
    };
  }, [host.lifecycle, host.reportError, reloadKey, reloadPortfolios]);

  useEffect(() => {
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || selectedId === null) {
      setPositions([]);
      setTransactions([]);
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    lifecycle.signal.addEventListener("abort", cancel, { once: true });
    void Promise.all([
      host.data.read("portfolio.positions", { portfolioId: selectedId }, { signal: controller.signal }),
      host.data.read("portfolio.transactions", { portfolioId: selectedId }, { signal: controller.signal }),
    ]).then(([nextPositions, nextTransactions]) => {
      if (controller.signal.aborted) return;
      setPositions(nextPositions);
      setTransactions(nextTransactions);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(asErrorMessage(cause));
      host.reportError({ code: "data-unavailable", retryable: true });
    });
    return () => {
      lifecycle.signal.removeEventListener("abort", cancel);
      controller.abort();
    };
  }, [host.data, host.lifecycle, host.reportError, reloadKey, selectedId]);

  const refresh = useCallback(() => setReloadKey((current) => current + 1), []);

  async function runMutation(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const lifecycle = host.lifecycle.getSnapshot();
    if (!canWrite || lifecycle.phase !== "active") return;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    lifecycle.signal.addEventListener("abort", cancel, { once: true });
    setBusy(true);
    setError(null);
    try {
      await action(controller.signal);
      refresh();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(asErrorMessage(cause));
        host.reportError({ code: "request-failed", retryable: true });
      }
    } finally {
      lifecycle.signal.removeEventListener("abort", cancel);
      setBusy(false);
    }
  }

  function submitPortfolio(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const name = portfolioName.trim();
    if (name.length === 0 || name.length > 64) {
      setError("Use a portfolio name between 1 and 64 characters.");
      return;
    }
    void runMutation(async (signal) => {
      await host.actions.invoke("portfolio.create", { name }, { signal });
      setPortfolioName("");
    });
  }

  function submitTransaction(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (selectedId === null) return;
    const normalizedSymbol = symbol.trim().toUpperCase();
    const numericQuantity = Number(quantity);
    const numericPrice = Number(price);
    const localDate = new Date(executedAt);
    if (!/^[A-Z0-9.^=-]{1,12}$/u.test(normalizedSymbol) ||
        !Number.isFinite(numericQuantity) || numericQuantity <= 0 || numericQuantity > 1_000_000_000 ||
        !Number.isFinite(numericPrice) || numericPrice < 0 || numericPrice > 1_000_000_000 ||
        !Number.isFinite(localDate.getTime())) {
      setError("Enter a valid symbol, quantity, price, and transaction time.");
      return;
    }
    void runMutation(async (signal) => {
      await host.actions.invoke("portfolio.transaction.create", {
        portfolioId: selectedId,
        symbol: normalizedSymbol,
        side,
        quantity: numericQuantity,
        price: numericPrice,
        executed_at: localDate.toISOString(),
      }, { signal });
      setSymbol("");
      setQuantity("");
      setPrice("");
      setExecutedAt(localDateTimeValue());
    });
  }

  return (
    <section className={styles.root} aria-label="Manual portfolio ledger">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Manual ledger</p>
          <h2>Portfolios</h2>
          <p className={styles.note}>Entries are user-maintained. No broker positions or live market valuation are shown.</p>
        </div>
        <button type="button" className={styles.quietButton} onClick={refresh} disabled={busy}>
          Refresh
        </button>
      </header>

      {error && <p role="alert" className={styles.error}>{error}</p>}

      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label="Portfolio list">
          <div className={styles.listHeader}>
            <h3>Your ledgers</h3>
            <span>{portfolios.length}</span>
          </div>
          {portfolios.length === 0 ? <p className={styles.empty}>No manual ledgers yet.</p> : (
            <ul className={styles.portfolioList}>
              {portfolios.map((portfolio) => (
                <li key={portfolio.id}>
                  <button
                    type="button"
                    className={`${styles.portfolioChoice} ${portfolio.id === selectedId ? styles.selected : ""}`}
                    aria-pressed={portfolio.id === selectedId}
                    onClick={() => setSelectedId(portfolio.id)}
                  >
                    <span>{portfolio.name}</span>
                    <small>Created {new Date(portfolio.created_at).toLocaleDateString()}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {canWrite && (
            <form className={styles.createForm} onSubmit={submitPortfolio}>
              <label htmlFor="portfolio-name">New ledger</label>
              <div className={styles.inlineForm}>
                <input id="portfolio-name" value={portfolioName} maxLength={64} onChange={(event) => setPortfolioName(event.target.value)} placeholder="Name" />
                <button type="submit" disabled={busy || portfolioName.trim().length === 0}>Add</button>
              </div>
            </form>
          )}
          {!canWrite && <p className={styles.permissionNote}>Read-only access</p>}
        </aside>

        <div className={styles.content}>
          {!selected ? (
            <p className={styles.emptyLarge}>Select or create a manual ledger to review its entries.</p>
          ) : (
            <>
              <div className={styles.selectedHeader}>
                <div>
                  <p className={styles.eyebrow}>Selected ledger</p>
                  <h3>{selected.name}</h3>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className={styles.dangerButton}
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Delete the manual ledger “${selected.name}” and its entries?`)) return;
                      void runMutation(async (signal) => {
                        await host.actions.invoke("portfolio.delete", { portfolioId: selected.id }, { signal });
                      });
                    }}
                  >Delete ledger</button>
                )}
              </div>

              <section className={styles.positions} aria-label="Manual ledger positions">
                <div className={styles.sectionHeading}>
                  <div><h4>Ledger positions</h4><p>Average cost and realized result from entered transactions only.</p></div>
                </div>
                <div className={styles.tableWrap}>
                  <table>
                    <thead><tr><th>Symbol</th><th>Quantity</th><th>Average cost</th><th>Realized P&amp;L</th></tr></thead>
                    <tbody>
                      {positions.length === 0 ? <tr><td colSpan={4} className={styles.emptyCell}>No transaction-derived positions.</td></tr> : positions.map((position) => (
                        <tr key={position.symbol}>
                          <td className={styles.symbol}>{position.symbol}</td>
                          <td>{formatLedgerNumber(position.quantity)}</td>
                          <td>{formatLedgerNumber(position.avgCost)}</td>
                          <td className={position.realizedPnl < 0 ? styles.negative : styles.positive}>{formatLedgerNumber(position.realizedPnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {canWrite && (
                <form className={styles.transactionForm} onSubmit={submitTransaction}>
                  <div className={styles.sectionHeading}>
                    <div><h4>Add a transaction</h4><p>Manual record only; this does not submit a broker order.</p></div>
                  </div>
                  <div className={styles.formGrid}>
                    <label>Side<select value={side} onChange={(event) => setSide(event.target.value as "BUY" | "SELL")}><option value="BUY">Buy</option><option value="SELL">Sell</option></select></label>
                    <label>Symbol<input value={symbol} maxLength={12} onChange={(event) => setSymbol(event.target.value)} placeholder="AAPL" autoCapitalize="characters" /></label>
                    <label>Quantity<input type="number" min="0.000001" max="1000000000" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
                    <label>Unit price<input type="number" min="0" max="1000000000" step="any" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
                    <label className={styles.timeField}>Transaction time<input type="datetime-local" value={executedAt} onChange={(event) => setExecutedAt(event.target.value)} /></label>
                    <button type="submit" disabled={busy || !symbol || !quantity || !price}>Add transaction</button>
                  </div>
                </form>
              )}

              <section className={styles.transactions} aria-label="Manual transactions">
                <div className={styles.sectionHeading}>
                  <div><h4>Transactions</h4><p>{transactions.length} manual {transactions.length === 1 ? "entry" : "entries"}</p></div>
                </div>
                <div className={styles.tableWrap}>
                  <table>
                    <thead><tr><th>Time (UTC)</th><th>Side</th><th>Symbol</th><th>Quantity</th><th>Unit price</th>{canWrite && <th><span className={styles.srOnly}>Actions</span></th>}</tr></thead>
                    <tbody>
                      {transactions.length === 0 ? <tr><td colSpan={canWrite ? 6 : 5} className={styles.emptyCell}>No transactions recorded.</td></tr> : transactions.map((transaction) => (
                        <tr key={transaction.id}>
                          <td>{new Date(transaction.executed_at).toLocaleString(undefined, { timeZone: "UTC" })}</td>
                          <td><span className={transaction.side === "BUY" ? styles.buy : styles.sell}>{transaction.side}</span></td>
                          <td className={styles.symbol}>{transaction.symbol}</td>
                          <td>{formatLedgerNumber(transaction.quantity)}</td>
                          <td>{formatLedgerNumber(transaction.price)}</td>
                          {canWrite && <td><button type="button" className={styles.removeButton} disabled={busy} onClick={() => void runMutation(async (signal) => {
                            await host.actions.invoke("portfolio.transaction.delete", { portfolioId: selected.id, transactionId: transaction.id }, { signal });
                          })}>Remove</button></td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
