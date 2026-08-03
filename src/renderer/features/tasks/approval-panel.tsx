import React from "react";
import type { TaskInspectorModel } from "../../../shared/contracts/domain";
import type { TaskWorkerCommand } from "../../../shared/contracts/protocol";

export function ApprovalPanel(props: {
  model: TaskInspectorModel;
  request(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
}): React.JSX.Element | null {
  const pending = props.model.pendingApproval;
  if (!pending || pending.kind !== "task_scope") return null;
  const decide = (decision: "approved" | "rejected") => props.request({
    type: "task.approveScope",
    payload: {
      taskId: props.model.task.id,
      approvalRequestId: pending.id,
      decision,
      displayedScopeHash: pending.scopeHash
    }
  });
  return (
    <section className="task-panel" aria-label="任務範圍核准">
      <h3>要求的執行範圍</h3>
      <p>{pending.scope.commandClasses.join(", ")}</p>
      <div className="button-row">
        <button type="button" onClick={() => void decide("approved")}>核准任務範圍</button>
        <button className="danger-button" type="button" onClick={() => void decide("rejected")}>拒絕</button>
      </div>
    </section>
  );
}
