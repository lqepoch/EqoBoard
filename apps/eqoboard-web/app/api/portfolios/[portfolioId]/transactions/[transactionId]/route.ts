import { NextResponse, type NextRequest } from "next/server";
import { authorizeRequest, noStoreJson } from "@/lib/server/bff-security";
import { getNativeDb, secureNativeDbFilesForRequest } from "@/lib/server/native-db";
import { ownerKeyForPrincipal } from "@/lib/server/auth";
import {
  isEmptyReadRequest,
  numericPathId,
  portfolioLimitResponse,
} from "@/lib/server/portfolio-http";
import { deletePortfolioTransaction } from "@/lib/server/portfolio-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = Readonly<{ params: Promise<{ portfolioId: string; transactionId: string }> }>;

export async function DELETE(request: NextRequest, context: RouteContext) {
  const authorization = await authorizeRequest(request, "workspace:write");
  if (!authorization.ok) return authorization.response;
  const { portfolioId: rawPortfolioId, transactionId: rawTransactionId } = await context.params;
  const portfolioId = numericPathId(rawPortfolioId);
  const transactionId = numericPathId(rawTransactionId);
  if (!portfolioId || !transactionId) return noStoreJson({ error: "portfolio_not_found" }, 404);
  if (!isEmptyReadRequest(request)) return noStoreJson({ error: "invalid_request" }, 400);
  const limited = portfolioLimitResponse(authorization.principal);
  if (limited) return limited;
  const db = getNativeDb();
  if (!db) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  try {
    const result = deletePortfolioTransaction(
      db,
      portfolioId,
      transactionId,
      ownerKeyForPrincipal(authorization.principal),
    );
    if (!secureNativeDbFilesForRequest())
      return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
    if (result.kind === "not-found") return noStoreJson({ error: "portfolio_not_found" }, 404);
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  }
}
