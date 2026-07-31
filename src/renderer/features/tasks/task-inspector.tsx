import React from "react";
import type { TaskInspectorModel } from "../../../shared/contracts/domain";
import type { TaskWorkerCommand } from "../../../shared/contracts/protocol";
import { ApprovalPanel } from "./approval-panel";
import { CandidatePanel } from "./candidate-panel";
import { RecoveryPanel } from "./recovery-panel";

export function TaskInspector(props: {
  model: TaskInspectorModel;
  request(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
}): React.JSX.Element {
  return (
    <div className="task-inspector">
      <p className="section-kicker">Task</p>
      <h3 data-testid="task-state">{props.model.task.state}</h3>
      <p>Lead: {props.model.task.leadProvider}</p>
      <p>Round {props.model.task.collaborationRoundsUsed} of {props.model.task.collaborationRoundBudget}</p>
      <p>Human revisions: {props.model.task.humanRevisionCount}</p>
      {props.model.task.failure ? (
        <p role="alert">{props.model.task.failure.code}: {props.model.task.failure.message}</p>
      ) : null}
      {props.model.activeRuns.map((run) => <p key={run.id}>{run.provider} {run.role}: {run.state}</p>)}
      {props.model.worktrees.map((worktree) => <p className="path-value" key={worktree.id}>{worktree.pathRealpath}</p>)}
      {props.model.checkpoints.map((checkpoint) => <p className="path-value" key={checkpoint.id}>{checkpoint.immutableRef}</p>)}
      <ApprovalPanel model={props.model} request={props.request} />
      <CandidatePanel model={props.model} request={props.request} />
      <RecoveryPanel model={props.model} request={props.request} />
      {!["Completed", "Cancelled", "Failed"].includes(props.model.task.state) ? (
        <button type="button" onClick={() => void props.request({ type: "task.cancel", payload: { taskId: props.model.task.id, reason: "user" } })}>Stop task</button>
      ) : null}
    </div>
  );
}
