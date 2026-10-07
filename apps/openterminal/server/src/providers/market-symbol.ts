const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;
const NON_US_SUFFIXES = [
  ".MI", ".PA", ".AS", ".BR", ".LS", ".DE", ".L", ".MC", ".SW", ".ST", ".CO", ".HE",
  ".OL", ".TO", ".AX", ".HK", ".T", ".NS", ".BO", ".TW", ".TWO", ".KS", ".KQ", ".SS",
  ".SZ", ".SI", ".JK", ".KL", ".BK", ".SA", ".MX", ".SN", ".ME", ".IS", ".TA", ".IL",
];

/** True only for plain U.S.-listed equity/ETF symbols served by Alpaca SIP. */
export function usesSIPEquitySymbol(symbol: string): boolean {
  const value = symbol.trim().toUpperCase();
  return TICKER.test(value) && value !== "VIX" && !value.endsWith("-USD") &&
    !NON_US_SUFFIXES.some((suffix) => value.endsWith(suffix));
}
