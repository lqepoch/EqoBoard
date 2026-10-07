const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;
export const CRYPTO_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB",
  XRP: "XRP", ADA: "Cardano", DOGE: "Dogecoin", AVAX: "Avalanche",
  DOT: "Polkadot", LINK: "Chainlink", LTC: "Litecoin", MATIC: "Polygon",
});
/** Base symbols used only by dedicated crypto endpoints, never generic quotes/history routing. */
export const CRYPTO_SYMBOLS = new Set(Object.keys(CRYPTO_ASSETS));

const EXPLICIT_CRYPTO_PAIR = /^([A-Z0-9]{2,12})-USD$/;

/** Generic market routes require an explicit currency pair before using a crypto source. */
export function isExplicitCryptoSymbol(symbol: string): boolean {
  const match = EXPLICIT_CRYPTO_PAIR.exec(symbol.trim().toUpperCase());
  return match !== null && CRYPTO_SYMBOLS.has(match[1]);
}

const NON_US_SUFFIXES = [
  ".MI", ".PA", ".AS", ".BR", ".LS", ".DE", ".L", ".MC", ".SW", ".ST", ".CO", ".HE",
  ".OL", ".TO", ".AX", ".HK", ".T", ".NS", ".BO", ".TW", ".TWO", ".KS", ".KQ", ".SS",
  ".SZ", ".SI", ".JK", ".KL", ".BK", ".SA", ".MX", ".SN", ".ME", ".IS", ".TA", ".IL",
];

/** True only for plain U.S.-listed equity/ETF symbols served by Alpaca SIP. */
export function usesSIPEquitySymbol(symbol: string): boolean {
  const value = symbol.trim().toUpperCase();
  return TICKER.test(value) && value !== "VIX" && !isExplicitCryptoSymbol(value) &&
    !NON_US_SUFFIXES.some((suffix) => value.endsWith(suffix));
}
