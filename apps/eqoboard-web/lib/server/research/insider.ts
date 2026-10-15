import { XMLParser } from "fast-xml-parser";

import { readProviderJson, readProviderText, finiteNumber } from "./transport";
import type { ProviderResult } from "./types";

export type InsiderTransaction = Readonly<{
  filingDate: string;
  transactionDate: string | null;
  filingUrl: string;
  ownerName: string;
  ownerTitle: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  transactionCode: string;
  acquiredDisposed: "A" | "D" | null;
  shares: number | null;
  pricePerShare: number | null;
  sharesOwnedAfter: number | null;
}>;

type FilingRef = Readonly<{ accessionNumber: string; filingDate: string; primaryDocument: string }>;
type CompanyTicker = Readonly<{ ticker?: unknown; cik_str?: unknown }>;

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
  allowBooleanAttributes: false,
});
const source = Object.freeze({
  provider: "SEC EDGAR Form 4",
  providerUrl: "https://www.sec.gov/edgar/search/",
  sourcePath: "apps/openterminal/server/src/providers/secedgar.ts",
  license: null,
});

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = record(current)?.[key];
  return current;
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

function secContact(): string | null {
  const value = process.env.SEC_EDGAR_CONTACT?.trim();
  return value && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value) ? value : null;
}

async function fetchJson<T>(url: URL, contact: string): Promise<T> {
  const text = await readProviderText(url, {
    timeoutMs: 8_000,
    maxBytes: 4 * 1024 * 1024,
    headers: { Accept: "application/json", "User-Agent": `EqoBoard Research ${contact}` },
  });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("sec-response-invalid-json");
  }
}

let contactQueue = Promise.resolve();
let lastSecRequestAt = 0;
async function secRequestTurn(): Promise<() => void> {
  const prior = contactQueue;
  let release!: () => void;
  contactQueue = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  const waitMs = Math.max(0, 125 - (Date.now() - lastSecRequestAt));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastSecRequestAt = Date.now();
  return release;
}

async function withSecRateLimit<T>(work: () => Promise<T>): Promise<T> {
  const release = await secRequestTurn();
  try {
    return await work();
  } finally {
    release();
  }
}

async function resolveCik(symbol: string, contact: string): Promise<string | null> {
  const url = new URL("https://www.sec.gov/files/company_tickers.json");
  const data = await withSecRateLimit(() => fetchJson<unknown>(url, contact));
  const rows = record(data);
  if (!rows) throw new Error("sec-company-tickers-response-invalid");
  for (const entry of Object.values(rows) as CompanyTicker[]) {
    if (typeof entry.ticker === "string" && entry.ticker.toUpperCase() === symbol) {
      const cik = finiteNumber(entry.cik_str);
      return cik !== null && cik > 0 ? String(Math.trunc(cik)).padStart(10, "0") : null;
    }
  }
  return null;
}

async function recentFilings(cik: string, contact: string, limit: number): Promise<FilingRef[]> {
  const url = new URL(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const data = await withSecRateLimit(() => fetchJson<unknown>(url, contact));
  const recent = readPath(data, ["filings", "recent"]);
  const forms = readPath(recent, ["form"]);
  const accessions = readPath(recent, ["accessionNumber"]);
  const filingDates = readPath(recent, ["filingDate"]);
  const primaryDocuments = readPath(recent, ["primaryDocument"]);
  if (![forms, accessions, filingDates, primaryDocuments].every(Array.isArray)) {
    throw new Error("sec-submissions-response-invalid");
  }
  const found: FilingRef[] = [];
  for (let index = 0; index < forms.length && found.length < limit; index += 1) {
    if (forms[index] !== "4") continue;
    const accessionNumber = accessions[index];
    const filingDate = filingDates[index];
    const primaryDocument = primaryDocuments[index];
    if (typeof accessionNumber !== "string" || !/^\d{10}-\d{2}-\d{6}$/u.test(accessionNumber) ||
        typeof filingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(filingDate) ||
        typeof primaryDocument !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(primaryDocument)) continue;
    found.push({ accessionNumber, filingDate, primaryDocument });
  }
  return found;
}

function isTrue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

async function parseFiling(cik: string, filing: FilingRef, contact: string): Promise<InsiderTransaction[]> {
  const accessionNoDashes = filing.accessionNumber.replace(/-/gu, "");
  const primaryDocument = filing.primaryDocument.split("/").at(-1)!;
  const url = new URL(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/${primaryDocument}`);
  const body = await withSecRateLimit(() => readProviderText(url, {
    timeoutMs: 8_000,
    maxBytes: 1024 * 1024,
    headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.1", "User-Agent": `EqoBoard Research ${contact}` },
  }));
  let document: unknown;
  try {
    document = parser.parse(body);
  } catch {
    throw new Error("sec-form4-response-invalid-xml");
  }
  const ownership = readPath(document, ["ownershipDocument"]);
  if (!record(ownership)) throw new Error("sec-form4-response-invalid");
  const owners = asArray(readPath(ownership, ["reportingOwner"]));
  const transactions = asArray(readPath(ownership, ["nonDerivativeTable", "nonDerivativeTransaction"]));
  const filingUrl = url.toString();
  const result: InsiderTransaction[] = [];
  for (const owner of owners.slice(0, 10)) {
    const ownerName = safeText(readPath(owner, ["reportingOwnerId", "rptOwnerName"]), 160) ?? "Unknown";
    const relation = readPath(owner, ["reportingOwnerRelationship"]);
    const ownerTitle = safeText(readPath(relation, ["officerTitle"]), 120);
    for (const transaction of transactions.slice(0, 100)) {
      const acquired = safeText(readPath(transaction, ["transactionAmounts", "transactionAcquiredDisposedCode", "value"]), 1);
      const transactionDate = safeText(readPath(transaction, ["transactionDate", "value"]), 10);
      result.push(Object.freeze({
        filingDate: filing.filingDate,
        transactionDate: transactionDate && /^\d{4}-\d{2}-\d{2}$/u.test(transactionDate) ? transactionDate : null,
        filingUrl,
        ownerName,
        ownerTitle,
        isDirector: isTrue(readPath(relation, ["isDirector"])),
        isOfficer: isTrue(readPath(relation, ["isOfficer"])),
        isTenPercentOwner: isTrue(readPath(relation, ["isTenPercentOwner"])),
        transactionCode: safeText(readPath(transaction, ["transactionCoding", "transactionCode"]), 4) ?? "?",
        acquiredDisposed: acquired === "A" || acquired === "D" ? acquired : null,
        shares: finiteNumber(readPath(transaction, ["transactionAmounts", "transactionShares", "value"])),
        pricePerShare: finiteNumber(readPath(transaction, ["transactionAmounts", "transactionPricePerShare", "value"])),
        sharesOwnedAfter: finiteNumber(readPath(transaction, ["postTransactionAmounts", "sharesOwnedFollowingTransaction", "value"])),
      }));
    }
  }
  return result;
}

async function mapLimited<T, Result>(items: readonly T[], limit: number, run: (item: T) => Promise<Result>): Promise<PromiseSettledResult<Result>[]> {
  const results = new Array<PromiseSettledResult<Result>>(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index++;
      if (current >= items.length) return;
      try {
        results[current] = { status: "fulfilled", value: await run(items[current]!) };
      } catch (reason) {
        results[current] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

export async function loadInsiderTransactions(symbol: string): Promise<ProviderResult<readonly InsiderTransaction[]>> {
  const contact = secContact();
  if (!contact) throw new Error("sec-contact-unconfigured");
  const cik = await resolveCik(symbol, contact);
  if (!cik) {
    return {
      source,
      data: [],
      asOf: null,
      complete: false,
      failedItems: 1,
      truncated: false,
      warning: "SEC ticker mapping did not resolve; no filing query was attempted.",
    };
  }
  const filings = await recentFilings(cik, contact, 20);
  const results = await mapLimited(filings, 3, (filing) => parseFiling(cik, filing, contact));
  const failed = results.filter((result) => result.status === "rejected").length;
  const transactions = results.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .sort((left, right) => (right.transactionDate ?? right.filingDate).localeCompare(left.transactionDate ?? left.filingDate));
  return {
    source,
    data: transactions,
    asOf: null,
    complete: failed === 0,
    failedItems: failed,
    truncated: filings.length === 20,
    warning: "Only non-derivative Form 4 transactions are included. Filing and transaction dates are source dates; unresolved filings are reported as partial.",
  };
}
