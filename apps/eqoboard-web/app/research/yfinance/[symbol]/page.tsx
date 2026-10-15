import { notFound } from "next/navigation";
import { YahooResearchPage } from "@/features/research/YahooResearchPage";
import { isYfinanceResearchSymbol } from "@/features/research/yfinance-contract";
import { getNativeRuntimeMode, nativeRuntimeReadiness } from "@/lib/server/runtime-mode";

export default async function YahooResearchRoute({
  params,
}: Readonly<{ params: Promise<{ symbol: string }> }>) {
  const { symbol: rawSymbol } = await params;
  const symbol = rawSymbol.toUpperCase();
  if (getNativeRuntimeMode() !== "research" || !nativeRuntimeReadiness().ready || !isYfinanceResearchSymbol(symbol)) {
    notFound();
  }
  return <YahooResearchPage initialSymbol={symbol} />;
}
