import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { NextFunction, Request, Response } from "express";

const BFF_ISSUER = "eqoboard-openterminal";
const RESEARCH_ISSUER = "openterminal-research";
const RESEARCH_AUDIENCE = "openterminal-research";
const GATEWAY_AUDIENCE = "eqoboard-gateway";
const ALLOWED_SCOPES = new Set([
  "market:read", "market:stream", "market:subscribe", "research:read", "research:ai",
  "workspace:read", "workspace:write", "orders:preview", "paper:submit",
]);
const MARKET_SCOPED_PATHS = new Set(["heatmap", "screener", "sectors", "recap", "macro", "earnings-history"]);
const RESEARCH_SCOPED_PATHS = new Set([
  "quotes", "history", "search", "news", "econ-calendar", "options", "crypto", "calendar",
  "short-volume", "insider",
]);

export type VerifiedPrincipal = {
  subject: string;
  identityIssuer: string;
  ownerId: string;
  scopes: readonly string[];
};

declare global {
  namespace Express {
    interface Request {
      verifiedPrincipal?: VerifiedPrincipal;
    }
  }
}

function hmacSecret(value: string | undefined): Uint8Array | null {
  return value && value.length >= 64 && /^[\x21-\x7e]+$/.test(value)
    ? new TextEncoder().encode(value)
    : null;
}

function serviceKey(): Buffer | null {
  const value = process.env.EQO_RESEARCH_API_KEY;
  return value && value.length >= 32 ? Buffer.from(value) : null;
}

function ownerId(identityIssuer: string, subject: string): string {
  return createHash("sha256").update(identityIssuer).update("\0").update(subject).digest("hex");
}

function verifiedPrincipal(req: Request, res: Response): VerifiedPrincipal | null {
  const principal = req.verifiedPrincipal;
  if (principal) return principal;
  res.status(401).json({ error: "authentication_required" });
  return null;
}

export function requireResearchServiceKey(req: Request, res: Response, next: NextFunction): void {
  const expected = serviceKey();
  if (!expected) {
    res.status(503).json({ error: "research_service_unavailable" });
    return;
  }
  const provided = req.header("x-api-key") ?? "";
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.status(401).json({ error: "service_authentication_required" });
    return;
  }
  next();
}

export function requireDelegatedPrincipal(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const secret = hmacSecret(process.env.EQO_RESEARCH_JWT_SECRET);
    if (!secret) {
      res.status(503).json({ error: "identity_service_unavailable" });
      return;
    }
    const token = req.header("authorization")?.replace(/^Bearer /, "");
    if (!token || token === req.header("authorization")) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    try {
      const { payload, protectedHeader } = await jwtVerify(token, secret, {
        algorithms: ["HS256"],
        issuer: BFF_ISSUER,
        audience: RESEARCH_AUDIENCE,
        clockTolerance: 5,
        maxTokenAge: "65s",
      });
      const scopes = payload.scope;
      const now = Math.floor(Date.now() / 1000);
      if (
        protectedHeader.kid !== "research-bff" ||
        typeof payload.sub !== "string" || !payload.sub.trim() ||
        typeof payload.idp_iss !== "string" || !payload.idp_iss.trim() ||
        typeof payload.jti !== "string" || !payload.jti.trim() ||
        typeof payload.iat !== "number" || payload.iat > now + 5 ||
        typeof payload.exp !== "number" || payload.exp <= payload.iat || payload.exp - payload.iat > 65 ||
        !Array.isArray(scopes) || scopes.length !== 1 ||
        !scopes.every((scope) => typeof scope === "string" && ALLOWED_SCOPES.has(scope))
      ) {
        res.status(401).json({ error: "authentication_required" });
        return;
      }
      const identityIssuer = payload.idp_iss;
      const subject = payload.sub;
      req.verifiedPrincipal = {
        subject,
        identityIssuer,
        ownerId: ownerId(identityIssuer, subject),
        scopes,
      };
      next();
    } catch {
      res.status(401).json({ error: "authentication_required" });
    }
  })();
}

export function requireScopes(...required: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = verifiedPrincipal(req, res);
    if (!principal) return;
    if (!required.every((scope) => principal.scopes.includes(scope))) {
      res.status(403).json({ error: "action_forbidden" });
      return;
    }
    next();
  };
}

export function requirePortfolioScope(req: Request, res: Response, next: NextFunction): void {
  const scope = ["GET", "HEAD"].includes(req.method) ? "workspace:read" : "workspace:write";
  requireScopes(scope)(req, res, next);
}

export function requireResearchScopeForPath(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl.split("?", 1)[0]?.replace(/^\/api\/?/, "") ?? "";
  const root = path.split("/", 1)[0] ?? "";
  if (root === "portfolios" || root === "ai") return next();
  if (root === "status") return requireScopes("research:read")(req, res, next);
  if (MARKET_SCOPED_PATHS.has(root)) return requireScopes("market:read")(req, res, next);
  if (RESEARCH_SCOPED_PATHS.has(root)) return requireScopes("research:read")(req, res, next);
  return next();
}

export async function getGatewayAuthorization(
  principal: VerifiedPrincipal,
  requiredScope: "market:read",
): Promise<string> {
  if (!principal.scopes.includes(requiredScope)) throw new Error("action_forbidden");
  const secret = hmacSecret(process.env.EQO_RESEARCH_JWT_SECRET);
  if (!secret) throw new Error("identity_service_unavailable");
  return new SignJWT({
    idp_iss: principal.identityIssuer,
    scope: [requiredScope],
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: "research" })
    .setIssuer(RESEARCH_ISSUER)
    .setAudience(GATEWAY_AUDIENCE)
    .setSubject(principal.subject)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(secret);
}
