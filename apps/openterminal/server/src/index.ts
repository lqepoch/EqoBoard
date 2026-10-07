import express from "express";
import cors from "cors";
import { marketRouter } from "./routes/market.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { aiRouter } from "./routes/ai.js";
import { allStats } from "./providers/registry.js";
import {
  requireDelegatedPrincipal,
  requirePortfolioScope,
  requireResearchScopeForPath,
  requireResearchServiceKey,
  requireScopes,
} from "./auth.js";
import { rateLimit } from "./rateLimit.js";

const app = express();

// Off by default: req.ip then falls back to the immediate socket address
// (the bundled web proxy's own address when called through it), so every
// caller behind that proxy shares one rate-limit bucket — safe, if coarser
// than per-browser. Only set TRUST_PROXY=1 if you know exactly one trusted
// reverse proxy sits in front of this process (the bundled web proxy alone,
// or your own proxy in front of it that itself sets X-Forwarded-For from
// the real client and doesn't let callers inject their own value) —
// otherwise a caller can forge X-Forwarded-For to dodge the rate limit.
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

// Only the configured web origin may call this API from a browser. Without
// this, any website open in the same browser as the terminal could reach a
// server bound beyond localhost — cors() with no options reflects every
// origin.
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
app.use(cors({ origin: webOrigin }));
app.use(express.json({ limit: "64kb", strict: true }));

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "openterminal-research" }));
app.get("/readyz", (_req, res) => {
  const ready = Boolean(
    process.env.EQO_RESEARCH_API_KEY && process.env.EQO_RESEARCH_API_KEY.length >= 32 &&
    process.env.EQO_RESEARCH_JWT_SECRET && process.env.EQO_RESEARCH_JWT_SECRET.length >= 64,
  );
  res.status(ready ? 200 : 503).json({
    ready,
    identity_validation_configured: ready,
    execution_enabled: false,
  });
});

// Every API call comes from the private Next BFF and carries both its service
// key and a short-lived, user-bound delegation JWT. These credentials are
// independent and neither is sent to the browser.
app.use("/api", requireResearchServiceKey, requireDelegatedPrincipal);
app.use("/api", requireResearchScopeForPath, rateLimit({ windowMs: 60_000, max: 240 }), marketRouter);
app.use("/api/portfolios", requirePortfolioScope, portfolioRouter);
app.use(
  "/api/ai",
  requireScopes("research:ai"),
  rateLimit({ windowMs: 60_000, max: 10 }),
  aiRouter
);

app.get("/api/status", requireScopes("research:read"), (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    providers: allStats(),
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large"
    ? 413
    : error instanceof SyntaxError ? 400 : 500;
  res.status(status).json({ error: status === 413 ? "request_too_large" : status === 400 ? "invalid_json" : "request_failed" });
});

const PORT = Number(process.env.API_PORT ?? 4000);
// Bind to localhost by default so cloning and running this never exposes an
// unauthenticated-by-default API to the network. Set API_HOST=0.0.0.0 (and
// API_KEY + WEB_ORIGIN) to intentionally expose it beyond this machine.
const HOST = process.env.API_HOST ?? "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`OpenTerminal API listening on http://${HOST}:${PORT}`);
});
