import React from "react";
import type { TaskInspectorModel } from "../../../shared/contracts/domain";
import type { TaskWorkerCommand } from "../../../shared/contracts/protocol";

export function RecoveryPanel(props: {
  model: TaskInspectorModel;
  request(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
}): React.JSX.Element | null {
  if (props.model.task.state === "Interrupted" && !props.model.recovery) {
    return <button type="button" onClick={() => void props.request({ type: "task.recovery.preview", payload: { taskId: props.model.task.id } })}>預覽復原方案</button>;
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
    <section className="task-panel" aria-label="任務復原">
      <h3>復原</h3>
      <p>尚未重播任何副作用</p>
      {recovery.operations.map((operation) => <p key={operation.operationId}>{operation.operationType}: {operation.outcome}</p>)}
      <button type="button" onClick={() => void resolve("resume_recorded_phase")}>從記錄階段繼續</button>
      <button type="button" onClick={() => void resolve("keep_observed_state")}>保留目前狀態</button>
      <button className="danger-button" type="button" onClick={() => void resolve("cancel_and_retain")}>取消並保留檔案</button>
    </section>
  );
}
