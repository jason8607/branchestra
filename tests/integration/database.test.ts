import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/worker/storage/database";
import { runMigrations } from "../../src/worker/storage/migrations";

const roots: string[] = [];
const appliedMigrationQuery = "SELECT 1 FROM schema_migrations WHERE version = ?";

function createMigrationWorker(filePath: string, barrier: SharedArrayBuffer, start: SharedArrayBuffer): {
  ready: Promise<void>;
  complete: Promise<void>;
} {
  const source = `
    import { parentPort, workerData } from "node:worker_threads";

    const { openDatabase } = await import(workerData.databaseUrl);
    const { runMigrations } = await import(workerData.migrationsUrl);
    const database = openDatabase(workerData.filePath);
    const barrier = new Int32Array(workerData.barrier);
    const start = new Int32Array(workerData.start);
    let inTransaction = false;
    const coordinatedDatabase = {
      exec: database.exec.bind(database),
      prepare(sql) {
        const statement = database.prepare(sql);
        if (sql !== workerData.appliedMigrationQuery) return statement;
        return new Proxy(statement, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== "get" || typeof value !== "function") return value;
            return (...args) => {
              if (!inTransaction) {
                Atomics.add(barrier, 0, 1);
                Atomics.notify(barrier, 0);
                while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 10_000);
              }
              return value.apply(target, args);
            };
          }
        });
      },
      transaction(work) {
        return database.transaction(() => {
          inTransaction = true;
          try {
            return work();
          } finally {
            inTransaction = false;
          }
        });
      },
      close: database.close.bind(database)
    };

    try {
      parentPort.postMessage("ready");
      Atomics.wait(start, 0, 0);
      runMigrations(coordinatedDatabase);
      database.close();
      parentPort.postMessage("complete");
    } catch (error) {
      try {
        database.close();
      } catch {}
      throw error;
    }
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    execArgv: ["--experimental-strip-types"],
    workerData: {
      appliedMigrationQuery,
      barrier,
      databaseUrl: new URL("../../src/worker/storage/database.ts", import.meta.url).href,
      filePath,
      migrationsUrl: new URL("../../src/worker/storage/migrations.ts", import.meta.url).href,
      start
    }
  });
  let resolveReady: () => void;
  let rejectReady: (reason: unknown) => void;
  let resolveComplete: () => void;
  let rejectComplete: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const complete = new Promise<void>((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  worker.on("message", (message: unknown) => {
    if (message === "ready") resolveReady();
    if (message === "complete") resolveComplete();
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectComplete(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`migration worker exited with code ${code}`);
      rejectReady(error);
      rejectComplete(error);
    }
  });
  return { ready, complete };
}

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

  it("restores outer transaction semantics after commit fails", () => {
    const database = openDatabase(":memory:");
    database.exec("CREATE TABLE values_under_test (value TEXT NOT NULL)");

    expect(() => database.transaction(() => {
      database.exec("ROLLBACK");
    })).toThrow(/cannot commit/i);

    database.transaction(() => {
      database.prepare("INSERT INTO values_under_test(value) VALUES (?)").run("recovered");
    });
    expect(database.prepare("SELECT value FROM values_under_test").all()).toEqual([{ value: "recovered" }]);
    database.close();
  });

  it("closes a raw handle when database configuration fails", () => {
    const originalExec = DatabaseSync.prototype.exec;
    const configurationError = new Error("configuration failed");
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string): void {
      if (sql === "PRAGMA busy_timeout = 5000") throw configurationError;
      originalExec.call(this, sql);
    });

    expect(() => openDatabase(":memory:")).toThrow(configurationError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("serializes concurrent production migrations after acquiring the migration lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-db-"));
    roots.push(root);
    const filePath = join(root, "branchestra.sqlite3");
    const initialization = openDatabase(filePath);
    initialization.close();
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const first = createMigrationWorker(filePath, barrier, start);
    await first.ready;
    const second = createMigrationWorker(filePath, barrier, start);
    await second.ready;
    Atomics.store(new Int32Array(start), 0, 1);
    Atomics.notify(new Int32Array(start), 0, 2);

    await expect(Promise.all([
      first.complete,
      second.complete
    ])).resolves.toEqual([undefined, undefined]);

    const database = openDatabase(filePath);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    database.close();
  });
});
