import type { WorkerCommand, WorkerResponsePayload } from "../../shared/contracts/protocol";
import { hashWorkerCommand, type DurableCommand } from "../storage/idempotency-store";

type SuccessPayload = Extract<WorkerResponsePayload, { ok: true }>;

export interface HandlerResult {
  data: SuccessPayload["data"];
  replayed: boolean;
}

export interface CommandContext {
  requestId: string;
  idempotencyKey: string;
  workerGeneration: string;
  durable(command: WorkerCommand): DurableCommand;
}

export interface CommandHandler<TType extends WorkerCommand["type"] = WorkerCommand["type"]> {
  readonly type: TType;
  handle(
    command: Extract<WorkerCommand, { type: TType }>,
    context: CommandContext
  ): Promise<HandlerResult> | HandlerResult;
}

export type AnyCommandHandler = {
  [TType in WorkerCommand["type"]]: CommandHandler<TType>
}[WorkerCommand["type"]];

export function createCommandContext(input: {
  requestId: string;
  idempotencyKey: string;
  workerGeneration: string;
}): CommandContext {
  return {
    ...input,
    durable: (command) => ({
      idempotencyKey: input.idempotencyKey,
      requestType: command.type,
      requestHash: hashWorkerCommand(command),
      workerGeneration: input.workerGeneration
    })
  };
}
