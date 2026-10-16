import "server-only";

import Database from "better-sqlite3";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const DATABASE_NAME = "eqoboard-native.sqlite3";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5_000;

let database: Database.Database | null = null;
let unavailable = false;

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Native data path is not a real directory.");
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function secureFile(path: string): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("Native database file is not a private regular file.");
    }
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function initialize(db: Database.Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion !== 0 && currentVersion !== 1) {
    throw new Error("Unsupported Native database schema version.");
  }
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
  db.pragma("secure_delete = ON");
  db.pragma("journal_mode = WAL");
  const createSchema = db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_documents (
      owner_key TEXT PRIMARY KEY NOT NULL CHECK(length(owner_key) = 64),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      document_json TEXT NOT NULL CHECK(length(document_json) <= 65536),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_key TEXT NOT NULL CHECK(length(owner_key) = 64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_key, name)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolio_records(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
      quantity REAL NOT NULL CHECK(quantity > 0),
      price REAL NOT NULL CHECK(price >= 0),
      executed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS portfolio_records_owner_idx
      ON portfolio_records(owner_key, id);
    CREATE INDEX IF NOT EXISTS transactions_portfolio_order_idx
      ON transactions(portfolio_id, executed_at, id);
    `);
    if (currentVersion === 0) db.pragma("user_version = 1");
  });
  createSchema.immediate();
}

/**
 * Open only the separately approved Native database. The first call is made
 * after route authorization; importing this module never creates a file.
 */
export function getNativeDb(): Database.Database | null {
  if (database) return database;
  if (unavailable) return null;

  const configuredDirectory = process.env.EQOBOARD_DATA_DIR;
  if (
    !configuredDirectory ||
    configuredDirectory.trim() !== configuredDirectory ||
    !isAbsolute(configuredDirectory)
  ) {
    unavailable = true;
    return null;
  }

  const directory = resolve(configuredDirectory);
  const filename = join(directory, DATABASE_NAME);
  try {
    ensurePrivateDirectory(directory);
    secureFile(filename);
    const opened = new Database(filename, { timeout: BUSY_TIMEOUT_MS });
    try {
      initialize(opened);
      secureFile(filename);
      secureFile(`${filename}-wal`);
      secureFile(`${filename}-shm`);
      database = opened;
      return database;
    } catch (error) {
      opened.close();
      throw error;
    }
  } catch {
    unavailable = true;
    return null;
  }
}

/** Test seam for isolated temporary data directories; never used by routes. */
export function resetNativeDbForTests(): void {
  database?.close();
  database = null;
  unavailable = false;
}

export function secureNativeDbFilesForRequest(): boolean {
  if (!database) return false;
  try {
    const directory = resolve(process.env.EQOBOARD_DATA_DIR ?? "");
    const filename = join(directory, DATABASE_NAME);
    chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    secureFile(filename);
    secureFile(`${filename}-wal`);
    secureFile(`${filename}-shm`);
    return true;
  } catch {
    return false;
  }
}
