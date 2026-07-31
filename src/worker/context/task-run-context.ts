import type { TaskRecord } from "../../shared/contracts/domain";
import { ContextBuilder } from "./context-builder";
import { ContextRepository } from "./context-repository";
import { stableJson } from "./stable-json";

export function createTaskRunContextPreparer(input: {
  builder: ContextBuilder;
  repository: ContextRepository;
  approvedScope(task: TaskRecord): unknown;
}) {
  return async (run: {
    runId: string;
    task: TaskRecord;
    role: "lead" | "collaborator";
    instruction: string;
    checkpointOid: string | null;
  }) => {
    const bundle = await input.builder.build({
      runId: run.runId,
      roomId: run.task.roomId,
      taskId: run.task.id,
      role: run.role,
      instruction: run.instruction,
      approvedScope: stableJson(input.approvedScope(run.task)),
      lead: run.task.leadProvider,
      injectedReadOnlySnapshot: stableJson({ checkpointOid: run.checkpointOid })
    });
    return {
      version: bundle.version,
      hash: `sha256:${bundle.hash}` as const,
      instruction: `READ-ONLY BRANCHESTRA CONTEXT\n${stableJson(bundle.payload)}\n\nTASK INSTRUCTION\n${run.instruction}`,
      persist: () => {
        input.repository.save(bundle, run.runId);
      }
    };
  };
}
