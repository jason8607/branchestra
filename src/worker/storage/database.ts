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

  constructor(raw: DatabaseSync) {
    this.#raw = raw;
  }

  exec(sql: string): void {
    this.#raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.#raw.prepare(sql);
  }

  transaction<T>(work: () => T): T {
    const depth = this.#transactionDepth;
    const savepoint = `branchestra_${depth}`;
    this.#raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const value = work();
      if (value instanceof Promise) throw new TypeError("Database transactions must be synchronous");
      this.#transactionDepth -= 1;
      this.#raw.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      this.#transactionDepth -= 1;
      this.#raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  close(): void {
    this.#raw.close();
  }
}

export function openDatabase(filePath: string): Database {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const raw = new DatabaseSync(filePath);
  raw.exec("PRAGMA foreign_keys = ON");
  if (filePath !== ":memory:") raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  return new SqliteDatabase(raw);
}
