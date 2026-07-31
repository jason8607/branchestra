import { execFile, type ChildProcess, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { hashCanonical } from "../approvals/canonical-json";
import type { OperationIntentRecord, OperationJournal } from "./operation-journal";

export interface ProcessCommand {
  commandId: string;
  commandClass: "build" | "test" | "lint" | "format";
  executableRealpath: string;
  argv: string[];
  cwdRealpath: string;
  timeoutMs: number;
}

export interface ProcessExecutionResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
}

interface ActiveProcess {
  child: ChildProcess;
  exited: Promise<void>;
  resolveExited(): void;
  cancelled: boolean;
  timedOut: boolean;
}

interface JournaledProcessRunnerOptions {
  journal: Pick<OperationJournal,
    "recordIntent" | "markExecuting" | "recordObservation" | "complete" | "needsAttention">;
  id(): string;
  now(): string;
  terminationGraceMs?: number;
}

const CONTROLLED_ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  CI: "1"
} as const;

const execDetached = execFile as unknown as (
  executable: string,
  argv: string[],
  options: {
    cwd: string;
    env: typeof CONTROLLED_ENV;
    shell: false;
    detached: true;
    encoding: "buffer";
    maxBuffer: number;
    windowsHide: true;
  },
  callback: (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void
) => ChildProcess;

function sha256(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function asBuffer(value: string | Buffer | null | undefined): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value ?? "", "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

export class JournaledProcessRunner {
  private readonly active = new Map<string, ActiveProcess>();
  private readonly terminationGraceMs: number;

  constructor(private readonly options: JournaledProcessRunnerOptions) {
    this.terminationGraceMs = options.terminationGraceMs ?? 1_000;
  }

  async run(input: {
    projectId: string;
    taskId: string;
    commonDirRealpath: string;
    command: ProcessCommand;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<ProcessExecutionResult> {
    this.assertCommand(input.command);
    const operationId = this.options.id();
    const createdAt = this.options.now();
    const intent: OperationIntentRecord<{
      commandId: string;
      commandClass: ProcessCommand["commandClass"];
      executableRealpath: string;
      argv: string[];
      cwdRealpath: string;
      timeoutMs: number;
      environmentHash: `sha256:${string}`;
    }> = {
      id: operationId,
      projectId: input.projectId,
      taskId: input.taskId,
      repositoryCommonDirRealpath: input.commonDirRealpath,
      operationType: "test.process",
      idempotencyKey: input.idempotencyKey,
      expected: {
        commandId: input.command.commandId,
        commandClass: input.command.commandClass,
        executableRealpath: input.command.executableRealpath,
        argv: [...input.command.argv],
        cwdRealpath: input.command.cwdRealpath,
        timeoutMs: input.command.timeoutMs,
        environmentHash: hashCanonical(CONTROLLED_ENV)
      },
      status: "intent",
      observation: null,
      workerGeneration: input.workerGeneration,
      createdAt,
      updatedAt: createdAt
    };
    const durable = this.options.journal.recordIntent(intent);
    if (!durable.created) {
      throw new Error(`OPERATION_REQUIRES_RECONCILIATION:${durable.record.id}`);
    }
    this.options.journal.markExecuting(operationId);

    const startedAt = Date.now();
    let resolveExited = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    try {
      const result = await new Promise<ProcessExecutionResult>((resolve, reject) => {
        let forceKill: ReturnType<typeof setTimeout> | undefined;
        const child = execDetached(input.command.executableRealpath, [...input.command.argv], {
          cwd: input.command.cwdRealpath,
          env: CONTROLLED_ENV,
          shell: false,
          detached: true,
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true
        }, (error, stdout, stderr) => {
          clearTimeout(timeout);
          if (forceKill !== undefined) clearTimeout(forceKill);
          const active = this.active.get(operationId);
          this.active.delete(operationId);
          resolveExited();
          const stdoutBuffer = asBuffer(stdout);
          const stderrBuffer = asBuffer(stderr);
          const durationMs = Math.max(0, Date.now() - startedAt);
          if (error && child.pid === undefined) {
            this.options.journal.needsAttention(operationId, {
              outcome: "not_applied",
              actual: { error: errorMessage(error) }
            });
            reject(error);
            return;
          }
          const timedOut = active?.timedOut ?? false;
          const cancelled = active?.cancelled ?? false;
          const errorCode = error && "code" in error && typeof error.code === "number" ? error.code : null;
          const exitCode = timedOut ? 124 : cancelled ? 130 : errorCode ?? child.exitCode ?? 0;
          const actual = {
            pid: child.pid ?? null,
            exitCode,
            signal: child.signalCode,
            timedOut,
            cancelled,
            durationMs,
            stdoutHash: sha256(stdoutBuffer),
            stderrHash: sha256(stderrBuffer)
          };
          this.options.journal.recordObservation(operationId, { outcome: "applied", actual });
          this.options.journal.complete(operationId);
          if (timedOut) {
            reject(new Error(`PROCESS_TIMEOUT:${input.command.commandId}`));
            return;
          }
          if (cancelled) {
            reject(new Error(`PROCESS_CANCELLED:${input.command.commandId}`));
            return;
          }
          resolve({ exitCode, stdout: stdoutBuffer, stderr: stderrBuffer, durationMs });
        });
        const active: ActiveProcess = {
          child,
          exited,
          resolveExited,
          cancelled: false,
          timedOut: false
        };
        this.active.set(operationId, active);
        const timeout = setTimeout(() => {
          active.timedOut = true;
          this.killGroup(child, "SIGTERM");
          forceKill = setTimeout(() => {
            if (this.active.has(operationId)) this.killGroup(child, "SIGKILL");
          }, this.terminationGraceMs);
        }, input.command.timeoutMs);
      });
      return result;
    } catch (error) {
      const active = this.active.get(operationId);
      if (active !== undefined && active.child.pid === undefined) {
        this.active.delete(operationId);
        active.resolveExited();
      }
      throw error;
    }
  }

  async cancel(operationId: string, deadlineMs: number): Promise<void> {
    const active = this.active.get(operationId);
    if (!active) throw new Error(`PROCESS_NOT_RUNNING:${operationId}`);
    active.cancelled = true;
    this.killGroup(active.child, "SIGTERM");
    const remaining = Math.max(0, deadlineMs - Date.now());
    await Promise.race([
      active.exited,
      new Promise<void>((resolve) => setTimeout(resolve, remaining))
    ]);
    if (this.active.has(operationId)) {
      this.killGroup(active.child, "SIGKILL");
      await active.exited;
    }
  }

  private assertCommand(command: ProcessCommand): void {
    if (!command.commandId || command.commandId.includes("\0")) throw new Error("PROCESS_COMMAND_ID_INVALID");
    if (!isAbsolute(command.executableRealpath)) throw new Error("PROCESS_EXECUTABLE_NOT_ABSOLUTE");
    if (!isAbsolute(command.cwdRealpath)) throw new Error("PROCESS_CWD_NOT_ABSOLUTE");
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 3_600_000) {
      throw new Error("PROCESS_TIMEOUT_INVALID");
    }
    if (command.argv.some((argument) => argument.includes("\0"))) throw new Error("PROCESS_ARGV_INVALID");
  }

  private killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        return;
      }
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}
