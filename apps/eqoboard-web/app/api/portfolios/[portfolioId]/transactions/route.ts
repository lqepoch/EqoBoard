import type { NextRequest } from "next/server";
import { authorizeRequest, noStoreJson, readBoundedJson } from "@/lib/server/bff-security";
import { getNativeDb, secureNativeDbFilesForRequest } from "@/lib/server/native-db";
import { ownerKeyForPrincipal } from "@/lib/server/auth";
import { isEmptyReadRequest, numericPathId, portfolioLimitResponse } from "@/lib/server/portfolio-http";
import { parsePortfolioTransaction } from "@/lib/server/portfolio-input";
import { createPortfolioTransaction, listPortfolioTransactions } from "@/lib/server/portfolio-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = Readonly<{ params: Promise<{ portfolioId: string }> }>;

export async function GET(request: NextRequest, context: RouteContext) {
  const authorization = await authorizeRequest(request, "workspace:read");
  if (!authorization.ok) return authorization.response;
  const { portfolioId: rawId } = await context.params;
  const portfolioId = numericPathId(rawId);
  if (!portfolioId) return noStoreJson({ error: "portfolio_not_found" }, 404);
  if (!isEmptyReadRequest(request)) return noStoreJson({ error: "invalid_request" }, 400);
  const limited = portfolioLimitResponse(authorization.principal);
  if (limited) return limited;
  const db = getNativeDb();
  if (!db) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  try {
    const result = listPortfolioTransactions(db, portfolioId, ownerKeyForPrincipal(authorization.principal));
    if (!secureNativeDbFilesForRequest()) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
    if (result.kind === "not-found") return noStoreJson({ error: "portfolio_not_found" }, 404);
    if (result.kind === "too-many") return noStoreJson({ error: "transaction_history_limit_exceeded" }, 413);
    return noStoreJson(result.value);
  } catch {
    return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const authorization = await authorizeRequest(request, "workspace:write");
  if (!authorization.ok) return authorization.response;
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_request" }, 400);
  const { portfolioId: rawId } = await context.params;
  const portfolioId = numericPathId(rawId);
  if (!portfolioId) return noStoreJson({ error: "portfolio_not_found" }, 404);
  const limited = portfolioLimitResponse(authorization.principal);
  if (limited) return limited;
  const body = await readBoundedJson(request, 8 * 1024);
  if (!body.ok) return body.response;
  const parsed = parsePortfolioTransaction(body.value);
  if (!parsed.ok) return noStoreJson({ error: "invalid_transaction" }, 400);
  const db = getNativeDb();
  if (!db) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  try {
    const result = createPortfolioTransaction(
      db,
      portfolioId,
      ownerKeyForPrincipal(authorization.principal),
      parsed.value,
    );
    if (!secureNativeDbFilesForRequest()) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
    if (result.kind === "not-found") return noStoreJson({ error: "portfolio_not_found" }, 404);
    if (result.kind === "too-many") return noStoreJson({ error: "transaction_history_limit_exceeded" }, 413);
    if (result.kind === "conflict") return noStoreJson({ error: "insufficient_position_for_sale" }, 409);
    return noStoreJson(result.value, 201);
  } catch {
    return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  }
}
