import React from "react";
import type { TaskInspectorModel } from "../../../shared/contracts/domain";
import type { TaskWorkerCommand } from "../../../shared/contracts/protocol";
import { ApprovalPanel } from "./approval-panel";
import { CandidatePanel } from "./candidate-panel";
import { RecoveryPanel } from "./recovery-panel";
import { AGENT_ROLE_LABEL, AGENT_RUN_STATE_LABEL, TASK_STATE_LABEL } from "../../locale/zh-TW";

export function TaskInspector(props: {
  model: TaskInspectorModel;
  request(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
}): React.JSX.Element {
  return (
    <div className="task-inspector">
      <p className="section-kicker">代理任務</p>
      <h3 data-testid="task-state">{TASK_STATE_LABEL[props.model.task.state]}</h3>
      <div className="task-facts">
        <p><span>主代理</span>{props.model.task.leadProvider === "claude" ? "Claude" : "Codex"}</p>
        <p aria-label={`協作回合 ${props.model.task.collaborationRoundsUsed} / ${props.model.task.collaborationRoundBudget}`}><span>協作回合</span>{props.model.task.collaborationRoundsUsed} / {props.model.task.collaborationRoundBudget}</p>
        <p><span>人工修訂</span>{props.model.task.humanRevisionCount}</p>
      </div>
      {props.model.task.failure ? (
        <p role="alert">{props.model.task.failure.code}: {props.model.task.failure.message}</p>
      ) : null}
      {props.model.activeRuns.map((run) => <p key={run.id}>{run.provider === "claude" ? "Claude" : "Codex"} · {AGENT_ROLE_LABEL[run.role]}：{AGENT_RUN_STATE_LABEL[run.state]}</p>)}
      {props.model.worktrees.map((worktree) => <p className="path-value" key={worktree.id}>{worktree.pathRealpath}</p>)}
      {props.model.checkpoints.map((checkpoint) => <p className="path-value" key={checkpoint.id}>{checkpoint.immutableRef}</p>)}
      <ApprovalPanel model={props.model} request={props.request} />
      <CandidatePanel model={props.model} request={props.request} />
      <RecoveryPanel model={props.model} request={props.request} />
      {!["Completed", "Cancelled", "Failed"].includes(props.model.task.state) ? (
        <button className="danger-button" type="button" onClick={() => void props.request({ type: "task.cancel", payload: { taskId: props.model.task.id, reason: "user" } })}>停止任務</button>
      ) : null}
    </div>
  );
}
