import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requirePortfolioScope, type VerifiedPrincipal } from "../auth.js";

let dataDir = "";
let previousDataDir: string | undefined;
let db!: (typeof import("../db.js"))["db"];
let createPortfolioRouter!: typeof import("./portfolio.js")["createPortfolioRouter"];

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "openterminal-portfolio-test-"));
  process.env.DATA_DIR = dataDir;
  ({ db } = await import("../db.js"));
  ({ createPortfolioRouter } = await import("./portfolio.js"));
});

afterAll(() => {
  db?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

function startPortfolioServer(options: { ownerLimit: number; serviceLimit: number }) {
  const app = express();
  let activeOwner: string | null = "portfolio-test-owner";
  app.use(express.json());
  app.use("/api/portfolios", (req, _res, next) => {
    if (activeOwner) {
      req.verifiedPrincipal = {
        subject: activeOwner,
        identityIssuer: "https://portfolio-test.invalid",
        ownerId: activeOwner,
        scopes: ["workspace:read", "workspace:write"],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      } satisfies VerifiedPrincipal;
    } else {
      delete req.verifiedPrincipal;
    }
    next();
  });
  app.use("/api/portfolios", requirePortfolioScope, createPortfolioRouter({ ...options, windowMs: 60_000 }));
  const server = app.listen(0, "127.0.0.1");
  const baseUrl = new Promise<string>((resolve) => {
    server.once("listening", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/api/portfolios`);
    });
  });
  return {
    server,
    baseUrl,
    setOwner(owner: string | null) { activeOwner = owner; },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("portfolio router request limits and ownership", () => {
  it("rejects an anonymous request before touching the database", async () => {
    const server = startPortfolioServer({ ownerLimit: 10, serviceLimit: 20 });
    const baseUrl = await server.baseUrl;
    const prepareSpy = vi.spyOn(db, "prepare");
    try {
      server.setOwner(null);
      const response = await fetch(baseUrl);
      expect(response.status).toBe(401);
      expect(prepareSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("isolates duplicate names by verified owner and hides another owner's portfolio", async () => {
    const server = startPortfolioServer({ ownerLimit: 20, serviceLimit: 100 });
    const baseUrl = await server.baseUrl;
    const ownerA = `owner-a-${crypto.randomUUID()}`;
    const ownerB = `owner-b-${crypto.randomUUID()}`;
    const name = `Shared ${crypto.randomUUID()}`;
    let portfolioA: number | undefined;
    let portfolioB: number | undefined;
    try {
      server.setOwner(ownerA);
      const createA = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      expect(createA.status).toBe(201);
      portfolioA = (await createA.json() as { id: number }).id;

      server.setOwner(ownerB);
      const createB = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      expect(createB.status).toBe(201);
      portfolioB = (await createB.json() as { id: number }).id;
      expect(portfolioB).not.toBe(portfolioA);

      const ownerBList = await fetch(baseUrl);
      expect((await ownerBList.json() as Array<{ id: number; name: string }>).map((row) => row.id))
        .toEqual([portfolioB]);
      const crossOwnerRead = await fetch(`${baseUrl}/${portfolioA}/transactions`);
      expect(crossOwnerRead.status).toBe(404);
      const crossOwnerDelete = await fetch(`${baseUrl}/${portfolioA}`, { method: "DELETE" });
      expect(crossOwnerDelete.status).toBe(404);
    } finally {
      if (portfolioA !== undefined || portfolioB !== undefined) {
        db.prepare("DELETE FROM portfolios WHERE id IN (?, ?)").run(portfolioA ?? -1, portfolioB ?? -1);
      }
      await server.close();
    }
  });

  it("returns HTTP 429 for an owner over limit without another database call", async () => {
    const server = startPortfolioServer({ ownerLimit: 1, serviceLimit: 10 });
    const baseUrl = await server.baseUrl;
    server.setOwner(`limited-owner-${crypto.randomUUID()}`);
    const prepareSpy = vi.spyOn(db, "prepare");
    try {
      const accepted = await fetch(baseUrl);
      expect(accepted.status).toBe(200);
      const callsAfterAccepted = prepareSpy.mock.calls.length;

      const rejected = await fetch(baseUrl);
      expect(rejected.status).toBe(429);
      expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await rejected.json()).toEqual({ error: "rate_limit_exceeded" });
      expect(prepareSpy.mock.calls).toHaveLength(callsAfterAccepted);

      server.setOwner(`another-owner-${crypto.randomUUID()}`);
      expect((await fetch(baseUrl)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("applies a shared service ceiling across owners before database access", async () => {
    const server = startPortfolioServer({ ownerLimit: 10, serviceLimit: 2 });
    const baseUrl = await server.baseUrl;
    const prepareSpy = vi.spyOn(db, "prepare");
    try {
      server.setOwner(`first-owner-${crypto.randomUUID()}`);
      expect((await fetch(baseUrl)).status).toBe(200);
      server.setOwner(`second-owner-${crypto.randomUUID()}`);
      expect((await fetch(baseUrl)).status).toBe(200);
      const callsAfterAccepted = prepareSpy.mock.calls.length;

      server.setOwner(`third-owner-${crypto.randomUUID()}`);
      const rejected = await fetch(baseUrl);
      expect(rejected.status).toBe(429);
      expect(prepareSpy.mock.calls).toHaveLength(callsAfterAccepted);
    } finally {
      await server.close();
    }
  });
});
