import { readFile } from "node:fs/promises";
import type { JsonValue } from "../../shared/contracts/domain";
import { hashBytes } from "../approvals/approved-workspace";
import type { OperationRecord } from "../operations/operation-journal";
import type { ProjectRepository } from "../storage/repositories";
import type { GitCommandRunner } from "./git-command-runner";

export interface ReconciledOperation {
  operationId: string;
  operationType: string;
  outcome: "not_applied" | "applied" | "conflict" | "uncertain";
  expected: Record<string, JsonValue>;
  actual: Record<string, JsonValue>;
  safeResolution: "mark_complete" | "keep_pending" | "human_attention";
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

function stringField(record: Record<string, JsonValue>, ...names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") return value;
  }
  return null;
}

export class GitOperationReconciler {
  constructor(private readonly options: {
    projects: Pick<ProjectRepository, "findById">;
    git: Pick<GitCommandRunner, "run">;
  }) {}

  async observe(record: OperationRecord): Promise<ReconciledOperation> {
    const expected = jsonRecord(record.expected);
    const result = (
      outcome: ReconciledOperation["outcome"],
      actual: Record<string, JsonValue>
    ): ReconciledOperation => ({
      operationId: record.id,
      operationType: record.operationType,
      outcome,
      expected,
      actual,
      safeResolution: outcome === "applied"
        ? "mark_complete"
        : outcome === "not_applied"
          ? "keep_pending"
          : "human_attention"
    });

    if (record.status === "observed" || record.status === "needs_attention") {
      const observation = jsonRecord(record.observation);
      const outcome = observation.outcome;
      const actual = jsonRecord(observation.actual);
      if (outcome === "applied" || outcome === "not_applied" || outcome === "conflict" || outcome === "uncertain") {
        return result(outcome, actual);
      }
    }

    if (record.operationType === "workspace.write") {
      const path = stringField(expected, "path");
      const contentHash = stringField(expected, "contentHash");
      if (!path || !contentHash) return result("uncertain", { reason: "invalid_expected_state" });
      try {
        const actualHash = hashBytes(await readFile(path));
        return result(actualHash === contentHash ? "applied" : "conflict", { path, contentHash: actualHash });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return result("not_applied", { path, exists: false });
        }
        return result("uncertain", { path, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const ref = stringField(expected, "immutableRef", "refName", "targetRef");
    const oid = stringField(expected, "candidateOid", "oid", "expectedOid");
    if (ref && oid) {
      const project = this.options.projects.findById(record.projectId);
      if (!project) return result("uncertain", { reason: "project_missing" });
      try {
        const actualOid = (await this.options.git.run(project.repositoryRoot, [
          "for-each-ref", "--count=1", "--format=%(objectname)", ref
        ])).stdout.trim();
        if (actualOid === "") return result("not_applied", { ref, oid: null });
        return result(actualOid === oid ? "applied" : "conflict", { ref, oid: actualOid });
      } catch (error) {
        return result("uncertain", { ref, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (record.operationType === "test.process") {
      return result("uncertain", { reason: "process_identity_not_live" });
    }
    return result("uncertain", { reason: "unsupported_operation_type" });
  }
}
