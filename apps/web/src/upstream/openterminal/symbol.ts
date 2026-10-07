/**
 * Adapted from ErTasselli/OpenTerminal web/lib/symbol.ts (MIT).
 * EqoBoard narrows symbol validation to the US-equity grammar accepted by Rust.
 */
const STOCK_RE = /^[A-Z][A-Z.\-]{0,11}$/;
export function normalizeSymbol(input: string): string | null {
  const value = input.trim().toUpperCase();
  return STOCK_RE.test(value) ? value : null;
}
