import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { WorkerCommand } from "../../shared/contracts/protocol";
import type { Database } from "./database";

export interface DurableCommand {
  idempotencyKey: string;
  requestType: string;
  requestHash: string;
  workerGeneration: string;
}

export interface DurableResult<T> {
  value: T;
  replayed: boolean;
}

export class IdempotencyConflictError extends Error {}

export interface IdempotencyStore {
  execute<T>(command: DurableCommand, resultSchema: ZodType<T>, mutation: () => T): DurableResult<T>;
}

export function hashWorkerCommand(command: WorkerCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

export function createIdempotencyStore(database: Database, now: () => string): IdempotencyStore {
  return {
    execute(command, resultSchema, mutation) {
      return database.transaction(() => {
        const existing = database.prepare("SELECT request_type, request_hash, status, response_json FROM idempotency_records WHERE idempotency_key = ?").get(command.idempotencyKey) as { request_type: string; request_hash: string; status: string; response_json: string | null } | undefined;
        if (existing) {
          if (existing.request_type !== command.requestType || existing.request_hash !== command.requestHash) {
            throw new IdempotencyConflictError(`Idempotency key conflict: ${command.idempotencyKey}`);
          }
          if (existing.status !== "completed" || existing.response_json === null) {
            throw new Error(`Incomplete idempotency record: ${command.idempotencyKey}`);
          }
          return { value: resultSchema.parse(JSON.parse(existing.response_json)), replayed: true };
        }

        const createdAt = now();
        database.prepare("INSERT INTO idempotency_records(idempotency_key, request_type, request_hash, worker_generation, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(command.idempotencyKey, command.requestType, command.requestHash, command.workerGeneration, createdAt);
        const value = resultSchema.parse(mutation());
        database.prepare("UPDATE idempotency_records SET status = 'completed', response_json = ?, completed_at = ? WHERE idempotency_key = ?").run(JSON.stringify(value), now(), command.idempotencyKey);
        return { value, replayed: false };
      });
    }
  };
}
