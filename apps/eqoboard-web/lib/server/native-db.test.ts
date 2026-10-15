import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

const { getNativeDb, resetNativeDbForTests, secureNativeDbFilesForRequest } = await import(
  "./native-db"
);

let dataDir: string | null = null;

afterEach(() => {
  resetNativeDbForTests();
  vi.unstubAllEnvs();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

describe("isolated Native SQLite storage", () => {
  it("does not open storage without an explicit data directory", () => {
    vi.stubEnv("EQOBOARD_DATA_DIR", "");
    expect(getNativeDb()).toBeNull();
  });

  it("opens lazily into a private new database without seeding legacy local rows", () => {
    dataDir = mkdtempSync(join(tmpdir(), "eqoboard-native-db-"));
    vi.stubEnv("EQOBOARD_DATA_DIR", dataDir);
    expect(existsSync(join(dataDir, "eqoboard-native.sqlite3"))).toBe(false);

    const db = getNativeDb();
    expect(db).not.toBeNull();
    if (!db) throw new Error("Expected the configured Native database to open.");
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "eqoboard-native.sqlite3")).mode & 0o777).toBe(0o600);
    expect(
      db.prepare("SELECT count(*) AS count FROM portfolio_records WHERE owner_key = 'local'").get(),
    ).toEqual({ count: 0 });
    expect(secureNativeDbFilesForRequest()).toBe(true);
  });
});
