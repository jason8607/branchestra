import React from "react";
import type { TaskInspectorModel } from "../../../shared/contracts/domain";
import type { TaskWorkerCommand } from "../../../shared/contracts/protocol";

export function RecoveryPanel(props: {
  model: TaskInspectorModel;
  request(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
}): React.JSX.Element | null {
  if (props.model.task.state === "Interrupted" && !props.model.recovery) {
    return <button type="button" onClick={() => void props.request({ type: "task.recovery.preview", payload: { taskId: props.model.task.id } })}>Preview recovery</button>;
  }
  const recovery = props.model.recovery;
  if (!recovery) return null;
  const resolve = (decision: "resume_recorded_phase" | "keep_observed_state" | "cancel_and_retain") => props.request({
    type: "task.recovery.resolve",
    payload: {
      taskId: props.model.task.id,
      previewHash: recovery.previewHash,
      decision,
      selectedOperationIds: recovery.operations.map(({ operationId }) => operationId)
    }
  });
  return (
    <section aria-label="Task recovery">
      <h3>Recovery</h3>
      <p>No side effects replayed</p>
      {recovery.operations.map((operation) => <p key={operation.operationId}>{operation.operationType}: {operation.outcome}</p>)}
      <button type="button" onClick={() => void resolve("resume_recorded_phase")}>Resume recorded phase</button>
      <button type="button" onClick={() => void resolve("keep_observed_state")}>Keep observed state</button>
      <button type="button" onClick={() => void resolve("cancel_and_retain")}>Cancel and retain</button>
    </section>
  );
}
