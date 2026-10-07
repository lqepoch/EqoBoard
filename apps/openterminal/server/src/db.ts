import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// DATA_DIR lets the Docker image point this at the mounted volume: once
// compiled, dist/db.js sits two levels below /app instead of server/src, so
// the source-relative default below would otherwise resolve outside /app.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const dataDir = process.env.DATA_DIR ?? join(root, "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "terminal.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS portfolios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_sub TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_sub, name)
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  price REAL NOT NULL CHECK (price >= 0),
  executed_at TEXT NOT NULL
);
`);

const portfolioColumns = db.prepare("PRAGMA table_info(portfolios)").all() as Array<{ name: string }>;
if (!portfolioColumns.some((column) => column.name === "owner_sub")) {
  // Existing local workspaces retain their rows, but the `local` owner is never
  // returned to an OIDC user. User-visible workspaces are created per subject.
  db.exec("ALTER TABLE portfolios ADD COLUMN owner_sub TEXT NOT NULL DEFAULT 'local'");
}

type IndexInfo = { name: string; unique: number };
type IndexColumn = { name: string | null };
const hasGlobalNameUnique = (db.pragma("index_list('portfolios')") as IndexInfo[]).some((index) => {
  if (!index.unique) return false;
  const escapedIndexName = index.name.replaceAll('"', '""');
  const columns = db.pragma(`index_info("${escapedIndexName}")`) as IndexColumn[];
  return columns.length === 1 && columns[0]?.name === "name";
});

if (hasGlobalNameUnique) {
  // Upgrade the old global name constraint without reassigning old local data
  // to an OIDC identity. Preserve portfolio/transaction IDs and rows. Foreign
  // keys are disabled only around this transactional table rebuild and checked
  // before committing.
  db.pragma("foreign_keys = OFF");
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    db.exec(`
      CREATE TABLE portfolios_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        owner_sub TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_sub, name)
      );
      INSERT INTO portfolios_new (id, name, owner_sub, created_at)
        SELECT id, name, owner_sub, created_at FROM portfolios;
      CREATE TABLE transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER NOT NULL REFERENCES portfolios_new(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
        quantity REAL NOT NULL CHECK (quantity > 0),
        price REAL NOT NULL CHECK (price >= 0),
        executed_at TEXT NOT NULL
      );
      INSERT INTO transactions_new (id, portfolio_id, symbol, side, quantity, price, executed_at)
        SELECT id, portfolio_id, symbol, side, quantity, price, executed_at FROM transactions;
      DROP TABLE transactions;
      DROP TABLE portfolios;
      ALTER TABLE portfolios_new RENAME TO portfolios;
      ALTER TABLE transactions_new RENAME TO transactions;
    `);
    const violations = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    if (violations.length > 0) throw new Error("portfolio migration left invalid foreign keys");
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

db.exec("CREATE INDEX IF NOT EXISTS portfolios_owner_sub_idx ON portfolios(owner_sub, id)");

const defaultPortfolio = db.prepare("SELECT id FROM portfolios LIMIT 1").get();
if (!defaultPortfolio) {
  db.prepare("INSERT INTO portfolios (name, owner_sub) VALUES (?, ?)").run("Main", "local");
}
