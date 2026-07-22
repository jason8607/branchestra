import type { TaskAction, TaskRecord, TaskState, TaskTransition } from "../../shared/contracts/domain";

export const NON_TERMINAL_TASK_STATES = [
  "AwaitingApproval", "Preparing", "Working", "Checkpoint", "Review1", "Revision", "Review2", "Candidate",
  "HumanApproval", "Merging", "CancelRequested", "Interrupted", "Reconciling"
] as const satisfies readonly TaskState[];

const activeCancellationStates = new Set<TaskState>(["Preparing", "Working", "Checkpoint", "Review1", "Revision", "Review2", "Candidate", "HumanApproval", "Merging", "CancelRequested"]);
const terminalTaskStates = new Set<TaskState>(["Completed", "Cancelled", "Failed"]);
const reconciliationOutcomes = new Set<TaskState>(["Completed", "HumanApproval", "Cancelled"]);

function moved(current: TaskRecord, patch: Partial<TaskRecord>, processLossGeneration?: string): TaskTransition {
  const next = { ...current, ...patch, version: current.version + 1 };
  return {
    previous: current,
    next,
    event: processLossGeneration === undefined
      ? { type: "task.transitioned", payload: { taskId: current.id, from: current.state, to: next.state, version: next.version } }
      : { type: "task.interrupted", payload: { taskId: current.id, from: current.state as Exclude<TaskState, "Completed" | "Cancelled" | "Failed">, workerGeneration: processLossGeneration } }
  };
}

function illegal(current: TaskRecord, action: TaskAction): never { throw new Error(`ILLEGAL_TRANSITION:${current.state}:${action.type}`); }

export function transitionTask(current: TaskRecord, action: TaskAction): TaskTransition {
  if (terminalTaskStates.has(current.state)) throw new Error(`TERMINAL_TASK:${current.state}`);
  if (action.type === "fail") return moved(current, { state: "Failed", failure: { code: action.code, message: action.message } });
  if (action.type === "processLoss") return moved(current, { state: "Interrupted", interruptedFromState: current.state === "Interrupted" ? current.interruptedFromState : current.state as TaskRecord["interruptedFromState"] }, action.generation);
  if (action.type === "cancel") return moved(current, { state: activeCancellationStates.has(current.state) ? "CancelRequested" : "Cancelled" });
  if (action.type === "beginReview") {
    if (current.state !== "Checkpoint" && current.state !== "Revision") return illegal(current, action);
    if (current.collaborationRoundsUsed >= current.collaborationRoundBudget) throw new Error("COLLABORATION_ROUND_BUDGET_EXHAUSTED");
    const round = current.collaborationRoundsUsed + 1;
    return moved(current, { state: round === 1 ? "Review1" : "Review2", collaborationRoundsUsed: round, revisionKind: null });
  }
  if (action.type === "requestHumanRevision") {
    if (current.state !== "HumanApproval") return illegal(current, action);
    return moved(current, { state: "Revision", humanRevisionCount: current.humanRevisionCount + 1, revisionKind: "human_directed" });
  }
  if (action.type === "grantAdditionalRounds") {
    if (current.state !== "HumanApproval" && current.state !== "Revision") return illegal(current, action);
    if (!Number.isInteger(action.additionalRounds) || action.additionalRounds < 1 || action.additionalRounds > 2) throw new Error("ADDITIONAL_ROUNDS_INVALID");
    return moved(current, { collaborationRoundBudget: current.collaborationRoundBudget + action.additionalRounds });
  }
  if (action.type === "resumeRecordedPhase") {
    if (current.state !== "Reconciling") return illegal(current, action);
    if (action.target === null || (!reconciliationOutcomes.has(action.target) && action.target !== current.interruptedFromState)) throw new Error("RECONCILIATION_TARGET_MISMATCH");
    return moved(current, { state: action.target, interruptedFromState: null });
  }
  switch (`${current.state}:${action.type}`) {
    case "AwaitingApproval:approveScope": {
      const scope = action as Extract<TaskAction, { type: "approveScope" }>;
      if (!Number.isInteger(scope.collaborationRoundBudget) || scope.collaborationRoundBudget < 0 || scope.collaborationRoundBudget > 2) throw new Error("INITIAL_COLLABORATION_ROUND_BUDGET_INVALID");
      return moved(current, { state: "Preparing", scopeApprovalId: scope.receiptId, collaborationRoundBudget: scope.collaborationRoundBudget });
    }
    case "AwaitingApproval:rejectScope": return moved(current, { state: "Cancelled" });
    case "Preparing:preparationSucceeded": return moved(current, { state: "Working" });
    case "Working:checkpointReady": return moved(current, { state: "Checkpoint" });
    case "Working:candidateReady": case "Checkpoint:candidateReady": case "Revision:candidateReady": case "Review2:candidateReady":
      return moved(current, { state: "Candidate", activeCandidateId: (action as Extract<TaskAction, { type: "candidateReady" }>).candidateId });
    case "Review1:requestAgentRevision": return moved(current, { state: "Revision", revisionKind: "agent_review" });
    case "Candidate:requestHumanApproval": return moved(current, { state: "HumanApproval" });
    case "HumanApproval:approveMerge": return moved(current, { state: "Merging" });
    case "Merging:mergeCompleted": return moved(current, { state: "Completed" });
    case "HumanApproval:approvalInvalidated": case "Merging:approvalInvalidated": return moved(current, { state: "HumanApproval" });
    case "CancelRequested:cancelSettled": return moved(current, { state: "Cancelled" });
    case "Interrupted:beginReconciliation": return moved(current, { state: "Reconciling" });
    default: return illegal(current, action);
  }
}
