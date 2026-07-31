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
    <section aria-label="Task scope approval">
      <h3>Requested scope</h3>
      <p>{pending.scope.commandClasses.join(", ")}</p>
      <button type="button" onClick={() => void decide("approved")}>Approve task scope</button>
      <button type="button" onClick={() => void decide("rejected")}>Reject task scope</button>
    </section>
  );
}
