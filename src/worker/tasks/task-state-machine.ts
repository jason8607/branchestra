import type { TaskAction, TaskRecord, TaskState, TaskTransition } from "../../shared/contracts/domain";

export const NON_TERMINAL_TASK_STATES = [
  "AwaitingApproval", "Preparing", "Working", "Checkpoint", "Review1", "Revision",
  "Review2", "Candidate", "HumanApproval", "Merging", "CancelRequested",
  "Interrupted", "Reconciling"
] as const satisfies readonly TaskState[];

const activeCancellationStates = new Set<TaskState>([
  "Preparing", "Working", "Checkpoint", "Review1", "Revision", "Review2",
  "Candidate", "HumanApproval", "Merging", "CancelRequested"
]);
const terminalTaskStates = new Set<TaskState>(["Completed", "Cancelled", "Failed"]);
const reconciliationOutcomes = new Set<TaskState>(["Completed", "HumanApproval", "Cancelled"]);

function moved(current: TaskRecord, patch: Partial<TaskRecord>, event: TaskTransition["event"]): TaskTransition {
  return { previous: current, next: { ...current, ...patch, version: current.version + 1 }, event };
}

function illegal(current: TaskRecord, action: TaskAction): never {
  throw new Error(`ILLEGAL_TRANSITION:${current.state}:${action.type}`);
}

export function transitionTask(current: TaskRecord, action: TaskAction): TaskTransition {
  if (terminalTaskStates.has(current.state)) throw new Error(`TERMINAL_TASK:${current.state}`);
  if (action.type === "fail") {
    return moved(current, { state: "Failed", failure: { code: action.code, message: action.message } },
      { type: "task.failed", payload: { code: action.code, message: action.message } });
  }
  if (action.type === "processLoss") {
    return moved(current, {
      state: "Interrupted",
      interruptedFromState: current.state === "Interrupted"
        ? current.interruptedFromState
        : current.state as TaskRecord["interruptedFromState"]
    }, { type: "task.interrupted", payload: { generation: action.generation, from: current.state } });
  }
  if (action.type === "cancel") {
    const state = activeCancellationStates.has(current.state) ? "CancelRequested" : "Cancelled";
    return moved(current, { state }, { type: "task.cancelled", payload: { reason: action.reason, pending: state === "CancelRequested" } });
  }
  if (action.type === "beginReview") {
    if (current.state !== "Checkpoint" && current.state !== "Revision") return illegal(current, action);
    if (current.collaborationRoundsUsed >= current.collaborationRoundBudget) {
      throw new Error("COLLABORATION_ROUND_BUDGET_EXHAUSTED");
    }
    const round = current.collaborationRoundsUsed + 1;
    return moved(current, {
      state: round === 1 ? "Review1" : "Review2", collaborationRoundsUsed: round, revisionKind: null
    }, { type: "task.reviewStarted", payload: { round, checkpointOid: action.checkpointOid } });
  }
  if (action.type === "requestHumanRevision") {
    if (current.state !== "HumanApproval") return illegal(current, action);
    return moved(current, {
      state: "Revision", humanRevisionCount: current.humanRevisionCount + 1, revisionKind: "human_directed"
    }, { type: "task.revisionRequested", payload: { source: "human", instruction: action.instruction } });
  }
  if (action.type === "grantAdditionalRounds") {
    if (current.state !== "HumanApproval" && current.state !== "Revision") return illegal(current, action);
    return moved(current, { collaborationRoundBudget: current.collaborationRoundBudget + action.additionalRounds },
      { type: "task.roundBudgetGranted", payload: { receiptId: action.receiptId, additionalRounds: action.additionalRounds } });
  }
  if (action.type === "resumeRecordedPhase") {
    if (current.state !== "Reconciling") return illegal(current, action);
    const target = action.target;
    if (target === null || (!reconciliationOutcomes.has(target) && target !== current.interruptedFromState)) {
      throw new Error("RECONCILIATION_TARGET_MISMATCH");
    }
    return moved(current, { state: target, interruptedFromState: null }, { type: "task.recovered", payload: { target } });
  }

  switch (`${current.state}:${action.type}`) {
    case "AwaitingApproval:approveScope":
      return moved(current, { state: "Preparing", scopeApprovalId: (action as Extract<TaskAction, { type: "approveScope" }>).receiptId, collaborationRoundBudget: (action as Extract<TaskAction, { type: "approveScope" }>).collaborationRoundBudget }, { type: "task.scopeApproved", payload: {} });
    case "AwaitingApproval:rejectScope":
      return moved(current, { state: "Cancelled" }, { type: "task.scopeRejected", payload: {} });
    case "Preparing:preparationSucceeded":
      return moved(current, { state: "Working" }, { type: "task.prepared", payload: {} });
    case "Working:checkpointReady":
      return moved(current, { state: "Checkpoint" }, { type: "task.checkpointReady", payload: { checkpointOid: (action as Extract<TaskAction, { type: "checkpointReady" }>).checkpointOid } });
    case "Working:candidateReady":
    case "Checkpoint:candidateReady":
    case "Revision:candidateReady":
    case "Review2:candidateReady":
      return moved(current, { state: "Candidate", activeCandidateId: (action as Extract<TaskAction, { type: "candidateReady" }>).candidateId }, { type: "task.candidateReady", payload: { candidateId: (action as Extract<TaskAction, { type: "candidateReady" }>).candidateId } });
    case "Review1:requestAgentRevision":
      return moved(current, { state: "Revision", revisionKind: "agent_review" }, { type: "task.revisionRequested", payload: { source: "reviewer", findings: (action as Extract<TaskAction, { type: "requestAgentRevision" }>).findings } });
    case "Candidate:requestHumanApproval":
      return moved(current, { state: "HumanApproval" }, { type: "task.humanApprovalRequested", payload: {} });
    case "HumanApproval:approveMerge":
      return moved(current, { state: "Merging" }, { type: "task.mergeApproved", payload: { receiptId: (action as Extract<TaskAction, { type: "approveMerge" }>).receiptId } });
    case "Merging:mergeCompleted":
      return moved(current, { state: "Completed" }, { type: "task.completed", payload: {} });
    case "HumanApproval:approvalInvalidated":
    case "Merging:approvalInvalidated":
      return moved(current, { state: "HumanApproval" }, { type: "task.approvalInvalidated", payload: { reason: (action as Extract<TaskAction, { type: "approvalInvalidated" }>).reason } });
    case "CancelRequested:cancelSettled":
      return moved(current, { state: "Cancelled" }, { type: "task.cancelled", payload: { pending: false } });
    case "Interrupted:beginReconciliation":
      return moved(current, { state: "Reconciling" }, { type: "task.reconciling", payload: {} });
    default:
      return illegal(current, action);
  }
}
