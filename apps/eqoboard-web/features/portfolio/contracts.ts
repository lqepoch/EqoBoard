export type ManualPortfolioV1 = Readonly<{
  id: number;
  name: string;
  created_at: string;
}>;

export type ManualPortfolioTransactionV1 = Readonly<{
  id: number;
  portfolio_id: number;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  executed_at: string;
}>;

export type ManualPortfolioPositionV1 = Readonly<{
  symbol: string;
  quantity: number;
  avgCost: number;
  realizedPnl: number;
}>;
