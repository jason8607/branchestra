import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspacePathGuard } from "../git/workspace-path-guard";
import type { JournaledOperationRunner } from "../operations/journaled-operation-runner";
import type { OperationIntentRecord } from "../operations/operation-journal";

export function hashBytes(contents: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

interface WorkspaceWriteContext {
  projectId: string;
  taskId: string;
  commonDirRealpath: string;
  workerGeneration: string;
  nextOperationId(): string;
  now(): string;
}

export function workspaceWriteIntent(
  context: WorkspaceWriteContext,
  path: string,
  contentHash: `sha256:${string}`
): OperationIntentRecord<{ path: string; contentHash: `sha256:${string}` }> {
  const operationId = context.nextOperationId();
  const createdAt = context.now();
  return {
    id: operationId,
    projectId: context.projectId,
    taskId: context.taskId,
    repositoryCommonDirRealpath: context.commonDirRealpath,
    operationType: "workspace.write",
    idempotencyKey: `workspace-write:${operationId}`,
    expected: { path, contentHash },
    status: "intent",
    observation: null,
    workerGeneration: context.workerGeneration,
    createdAt,
    updatedAt: createdAt
  };
}

export class ApprovedWorkspace {
  constructor(
    private readonly guard: WorkspacePathGuard,
    private readonly operations: JournaledOperationRunner,
    private readonly context: WorkspaceWriteContext
  ) {}

  async readText(candidate: string): Promise<string> {
    return readFile(await this.guard.resolveReadable(candidate), "utf8");
  }

  async writeText(candidate: string, contents: string): Promise<void> {
    const resolved = await this.guard.resolveWritable(candidate);
    const contentHash = hashBytes(Buffer.from(contents, "utf8"));
    await this.operations.run({
      intent: workspaceWriteIntent(this.context, resolved, contentHash),
      execute: async () => {
        await mkdir(dirname(resolved), { recursive: true });
        const checkedAgain = await this.guard.resolveWritable(resolved);
        if (checkedAgain !== resolved) throw new Error("PATH_CHANGED_DURING_AUTHORIZATION");
        const handle = await open(
          resolved,
          fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
          0o600
        );
        try {
          await handle.writeFile(contents, "utf8");
        } finally {
          await handle.close();
        }
      },
      observe: async () => {
        const actualHash = hashBytes(
          await readFile(await this.guard.resolveReadable(resolved))
        );
        return actualHash === contentHash
          ? {
              outcome: "applied" as const,
              actual: { path: resolved, contentHash: actualHash },
              result: undefined
            }
          : {
              outcome: "conflict" as const,
              actual: { path: resolved, contentHash: actualHash }
            };
      }
    });
  }
}
