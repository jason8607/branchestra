import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/worker/storage/database";
import { runMigrations } from "../../src/worker/storage/migrations";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker database", () => {
  it("enables WAL and foreign keys and migrates exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-db-"));
    roots.push(root);
    const database = openDatabase(join(root, "branchestra.sqlite3"));
    runMigrations(database);
    runMigrations(database);

    expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(database.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(tables).toEqual(expect.arrayContaining([
      { name: "idempotency_records" },
      { name: "projects" },
      { name: "room_events" },
      { name: "rooms" },
      { name: "schema_migrations" },
      { name: "worker_leases" }
    ]));
    database.close();
  });

  it("rolls back an outer transaction when a nested write fails", () => {
    const database = openDatabase(":memory:");
    database.exec("CREATE TABLE values_under_test (value TEXT NOT NULL)");
    expect(() => database.transaction(() => {
      database.prepare("INSERT INTO values_under_test(value) VALUES (?)").run("outer");
      database.transaction(() => {
        database.prepare("INSERT INTO values_under_test(value) VALUES (?)").run("inner");
        throw new Error("abort");
      });
    })).toThrow("abort");
    expect(database.prepare("SELECT value FROM values_under_test").all()).toEqual([]);
    database.close();
  });
});
