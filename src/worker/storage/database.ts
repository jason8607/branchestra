import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  transaction<T>(work: () => T): T;
  close(): void;
}

class SqliteDatabase implements Database {
  readonly #raw: DatabaseSync;
  #transactionDepth = 0;
  #closed = false;
  #poisoned = false;

  constructor(raw: DatabaseSync) {
    this.#raw = raw;
  }

  exec(sql: string): void {
    this.#assertUsable();
    this.#raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    this.#assertUsable();
    return this.#raw.prepare(sql);
  }

  transaction<T>(work: () => T): T {
    this.#assertUsable();
    const depth = this.#transactionDepth;
    const savepoint = `branchestra_${depth}`;
    this.#raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    let workCompleted = false;
    try {
      const value = work();
      if (value instanceof Promise) throw new TypeError("Database transactions must be synchronous");
      workCompleted = true;
      this.#raw.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      try {
        this.#raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        if (!workCompleted) this.#poison();
      }
      throw error;
    } finally {
      this.#transactionDepth = depth;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#raw.close();
  }

  #assertUsable(): void {
    if (this.#poisoned) throw new Error("Database is unusable after transaction cleanup failed");
    if (this.#closed) throw new Error("Database is closed");
  }

  #poison(): void {
    this.#poisoned = true;
    try {
      this.close();
    } catch {
      // Preserve the original work or finalization error when closing a poisoned handle fails.
    }
  }
}

export function openDatabase(filePath: string): Database {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const raw = new DatabaseSync(filePath);
  try {
    raw.exec("PRAGMA foreign_keys = ON");
    if (filePath !== ":memory:") raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA synchronous = NORMAL");
    raw.exec("PRAGMA busy_timeout = 5000");
    return new SqliteDatabase(raw);
  } catch (error) {
    try {
      raw.close();
    } catch {
      // Preserve the original configuration error when closing the handle also fails.
    }
    throw error;
  }
}
