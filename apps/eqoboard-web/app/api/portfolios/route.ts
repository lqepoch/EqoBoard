import type { NextRequest } from "next/server";
import { authorizeRequest, noStoreJson, readBoundedJson } from "@/lib/server/bff-security";
import { getNativeDb, secureNativeDbFilesForRequest } from "@/lib/server/native-db";
import { ownerKeyForPrincipal } from "@/lib/server/auth";
import { isEmptyReadRequest, portfolioLimitResponse } from "@/lib/server/portfolio-http";
import { parsePortfolioName } from "@/lib/server/portfolio-input";
import { createPortfolioRecord, listPortfolioRecords } from "@/lib/server/portfolio-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authorization = await authorizeRequest(request, "workspace:read");
  if (!authorization.ok) return authorization.response;
  if (!isEmptyReadRequest(request)) return noStoreJson({ error: "invalid_request" }, 400);
  const limited = portfolioLimitResponse(authorization.principal);
  if (limited) return limited;
  const db = getNativeDb();
  if (!db) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  try {
    const records = listPortfolioRecords(db, ownerKeyForPrincipal(authorization.principal));
    if (!secureNativeDbFilesForRequest()) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
    return noStoreJson(records);
  } catch {
    return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeRequest(request, "workspace:write");
  if (!authorization.ok) return authorization.response;
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_request" }, 400);
  const limited = portfolioLimitResponse(authorization.principal);
  if (limited) return limited;
  const body = await readBoundedJson(request, 4 * 1024);
  if (!body.ok) return body.response;
  const parsed = parsePortfolioName(body.value);
  if (!parsed.ok) return noStoreJson({ error: "invalid_portfolio" }, 400);
  const db = getNativeDb();
  if (!db) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  try {
    const result = createPortfolioRecord(db, ownerKeyForPrincipal(authorization.principal), parsed.name);
    if (!secureNativeDbFilesForRequest()) return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
    if (result.kind === "conflict") return noStoreJson({ error: "portfolio_name_conflict" }, 409);
    if (result.kind !== "ok") return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
    return noStoreJson(result.value, 201);
  } catch {
    return noStoreJson({ error: "portfolio_storage_unavailable" }, 503);
  }
}
