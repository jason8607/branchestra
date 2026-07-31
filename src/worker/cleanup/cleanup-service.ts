import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { hashCanonical } from "../approvals/canonical-json";
import type { GitCommandRunner } from "../git/git-command-runner";
import type { JournaledOperationRunner } from "../operations/journaled-operation-runner";
import type { OperationIntentRecord } from "../operations/operation-journal";
import type { RepositoryLock } from "../operations/repository-lock";
import type { Database } from "../storage/database";

export type CleanupPreview =
  | { kind: "room"; roomId: string; eventCount: number; throughSeq: number; activeTaskCount: number }
  | { kind: "project"; projectId: string; roomCount: number; activeTaskCount: number }
  | { kind: "worktree"; worktreeId: string; headOid: string; dirtyHash: string | null };
export type CleanupReceipt =
  | (Extract<CleanupPreview, { kind: "room" }> & { confirmation: string })
  | (Extract<CleanupPreview, { kind: "project" }> & { confirmation: string })
  | (Extract<CleanupPreview, { kind: "worktree" }> & { allowDirtyArchive: boolean });

function binding(value: CleanupPreview | CleanupReceipt): CleanupPreview {
  switch (value.kind) {
    case "room": return { kind: value.kind, roomId: value.roomId, eventCount: value.eventCount, throughSeq: value.throughSeq, activeTaskCount: value.activeTaskCount };
    case "project": return { kind: value.kind, projectId: value.projectId, roomCount: value.roomCount, activeTaskCount: value.activeTaskCount };
    case "worktree": return { kind: value.kind, worktreeId: value.worktreeId, headOid: value.headOid, dirtyHash: value.dirtyHash };
  }
}
export function validateCleanupReceipt(receipt: CleanupReceipt, current: CleanupPreview): void {
  if (hashCanonical(binding(receipt)) !== hashCanonical(binding(current))) throw new Error("CLEANUP_RECEIPT_STALE");
  if (current.kind === "project" && current.activeTaskCount !== 0) throw new Error("PROJECT_HAS_ACTIVE_TASKS");
  if (current.kind === "room" && current.activeTaskCount !== 0) throw new Error("ROOM_HAS_ACTIVE_TASKS");
  if (current.kind === "room" && receipt.kind === "room" && receipt.confirmation !== `DELETE ${current.roomId}`) throw new Error("ROOM_DELETE_CONFIRMATION_MISMATCH");
  if (current.kind === "project" && receipt.kind === "project" && receipt.confirmation !== `DELETE ${current.projectId}`) throw new Error("PROJECT_DELETE_CONFIRMATION_MISMATCH");
  if (current.kind === "worktree" && current.dirtyHash && receipt.kind === "worktree" && !receipt.allowDirtyArchive) throw new Error("DIRTY_WORKTREE_REQUIRES_ARCHIVE_CONFIRMATION");
}

interface WorktreeIdentityRow {
  worktreeId: string;
  taskId: string;
  pathRealpath: string;
  projectId: string;
  repositoryRoot: string;
  commonDir: string;
  taskState: string;
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export class CleanupService {
  constructor(private readonly options: {
    database: Database;
    git: Pick<GitCommandRunner, "run">;
    lock: RepositoryLock;
    operations: JournaledOperationRunner;
    recoveryRoot: string;
    workerGeneration: string;
    id(): string;
    now(): string;
  }) {
    if (!isAbsolute(options.recoveryRoot)) throw new Error("RECOVERY_ROOT_NOT_ABSOLUTE");
  }

  async previewWorktree(worktreeId: string): Promise<Extract<CleanupPreview, { kind: "worktree" }>> {
    const identity = this.identity(worktreeId);
    if (!new Set(["Completed", "Cancelled", "Failed"]).has(identity.taskState)) {
      throw new Error("WORKTREE_TASK_NOT_TERMINAL");
    }
    const headOid = (await this.options.git.run(identity.pathRealpath, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const dirty = (await this.options.git.run(identity.pathRealpath, ["status", "--porcelain=v1", "-z"])).stdout;
    return {
      kind: "worktree",
      worktreeId,
      headOid,
      dirtyHash: dirty.length === 0
        ? null
        : `sha256:${createHash("sha256").update(dirty).digest("hex")}`
    };
  }

  async archiveWorktree(
    receipt: Extract<CleanupReceipt, { kind: "worktree" }>,
    idempotencyKey: string
  ): Promise<{ recoveryPath: string }> {
    const identity = this.identity(receipt.worktreeId);
    await mkdir(this.options.recoveryRoot, { recursive: true, mode: 0o700 });
    const recoveryRoot = await realpath(this.options.recoveryRoot);
    if (contained(recoveryRoot, identity.pathRealpath)) {
      return { recoveryPath: identity.pathRealpath };
    }
    return this.options.lock.withLock(identity.commonDir, async () => {
      const current = await this.previewWorktree(receipt.worktreeId);
      validateCleanupReceipt(receipt, current);
      const recoveryPath = join(recoveryRoot, receipt.worktreeId, this.options.id());
      if (!contained(recoveryRoot, recoveryPath)) throw new Error("RECOVERY_PATH_ESCAPES_ROOT");
      if (await exists(recoveryPath)) throw new Error("RECOVERY_PATH_ALREADY_EXISTS");
      const createdAt = this.options.now();
      const intent: OperationIntentRecord<{
        worktreeId: string;
        source: string;
        recoveryPath: string;
        headOid: string;
        dirtyHash: string | null;
      }> = {
        id: this.options.id(),
        projectId: identity.projectId,
        taskId: identity.taskId,
        repositoryCommonDirRealpath: identity.commonDir,
        operationType: "archive-worktree",
        idempotencyKey,
        expected: {
          worktreeId: receipt.worktreeId,
          source: identity.pathRealpath,
          recoveryPath,
          headOid: receipt.headOid,
          dirtyHash: receipt.dirtyHash
        },
        status: "intent",
        observation: null,
        workerGeneration: this.options.workerGeneration,
        createdAt,
        updatedAt: createdAt
      };
      const result = await this.options.operations.run({
        intent,
        execute: async () => {
          await mkdir(join(recoveryPath, ".."), { recursive: true, mode: 0o700 });
          await rename(identity.pathRealpath, recoveryPath);
          await this.options.git.run(identity.repositoryRoot, ["worktree", "prune", "--expire", "now"]);
        },
        observe: async () => {
          const listing = (await this.options.git.run(identity.repositoryRoot, ["worktree", "list", "--porcelain"])).stdout;
          const actual = {
            sourceMissing: !(await exists(identity.pathRealpath)),
            recoveryPathExists: await exists(recoveryPath),
            stillRegistered: listing.split("\n").some((line) => line === `worktree ${identity.pathRealpath}`)
          };
          if (!actual.sourceMissing || !actual.recoveryPathExists || actual.stillRegistered) {
            return { outcome: "uncertain" as const, actual };
          }
          const current = this.options.database.prepare("SELECT path_realpath FROM worktrees WHERE id = ?")
            .get(receipt.worktreeId) as { path_realpath: string } | undefined;
          if (!current) throw new Error(`WORKTREE_NOT_FOUND:${receipt.worktreeId}`);
          if (current.path_realpath !== recoveryPath) {
            const updated = this.options.database.prepare(
              "UPDATE worktrees SET path_realpath = ? WHERE id = ? AND path_realpath = ?"
            ).run(recoveryPath, receipt.worktreeId, identity.pathRealpath);
            if (updated.changes !== 1) throw new Error("WORKTREE_ARCHIVE_RECORD_STALE");
          }
          return { outcome: "applied" as const, actual, result: { recoveryPath } };
        }
      });
      return result;
    });
  }

  private identity(worktreeId: string): WorktreeIdentityRow {
    const row = this.options.database.prepare(`SELECT
        w.id AS worktreeId, w.task_id AS taskId, w.path_realpath AS pathRealpath,
        t.project_id AS projectId, p.repository_root AS repositoryRoot, p.git_common_dir AS commonDir
        , t.state AS taskState
      FROM worktrees w
      JOIN tasks t ON t.id = w.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE w.id = ?`).get(worktreeId) as WorktreeIdentityRow | undefined;
    if (!row) throw new Error(`WORKTREE_NOT_FOUND:${worktreeId}`);
    return row;
  }
}
