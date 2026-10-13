import { localAccessOrigin, localRequestAllowed } from "@/lib/local-access";
import { NextRequest, NextResponse } from "next/server";
import { isResearchRouteAllowed } from "@/lib/research-route-access";

const NO_STORE = { "Cache-Control": "no-store" };

function rejected(): NextResponse {
  return NextResponse.json({ error: "route_not_available" }, { status: 404, headers: NO_STORE });
}

export function middleware(request: NextRequest): NextResponse {
  if (localAccessOrigin() && !localRequestAllowed(request)) {
    return NextResponse.json({ error: "local_origin_rejected" }, { status: 403, headers: NO_STORE });
  }
  if (process.env.EQO_BFF_MODE !== "research") return NextResponse.next();
  return isResearchRouteAllowed(request.url, request.nextUrl.pathname, request.method)
    ? NextResponse.next()
    : rejected();
}

export const config = {
  // Next's middleware adapter clones non-GET request bodies before invoking
  // route handlers. Let bounded JSON and NextAuth handlers read the original
  // stream so their route-level guards remain effective.
  matcher: [
    "/((?!api/auth(?:/|$)|api/portfolios(?:/|$)|api/ai/chat(?:/|$)|api/eqo/orders(?:/|$)|api/eqo/stocks/subscribe(?:/|$)|api/eqo/options/subscribe(?:/|$)).*)",
  ],
};
