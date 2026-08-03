import type { RoomEvent, TaskState } from "../../shared/contracts/domain";
import type { ProviderHealth } from "../../shared/contracts/provider";

export const CONNECTION_LABEL = {
  bootstrapping: "正在啟動",
  ready: "已連線",
  reconnecting: "正在重新連線",
  error: "需要處理",
} as const;

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  AwaitingApproval: "等待範圍核准",
  Preparing: "準備中",
  Working: "執行中",
  Checkpoint: "建立檢查點",
  Review1: "第一次審查",
  Revision: "修訂中",
  Review2: "第二次審查",
  Candidate: "建立候選版本",
  HumanApproval: "等待你的核准",
  Merging: "合併中",
  CancelRequested: "正在停止",
  Interrupted: "已中斷",
  Reconciling: "正在核對狀態",
  Completed: "已完成",
  Cancelled: "已取消",
  Failed: "失敗",
};

export const PROVIDER_STATE_LABEL: Record<ProviderHealth["state"], string> = {
  missing: "找不到相容版本",
  incompatible: "版本或設定不相容",
  unauthenticated: "尚未登入",
  policy_disabled: "目前未開放",
  ready: "可以使用",
};

export const AGENT_ROLE_LABEL = {
  lead: "主代理",
  collaborator: "協作者",
  reviewer: "審查者",
} as const;

export const AGENT_RUN_STATE_LABEL = {
  starting: "正在啟動",
  running: "執行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失敗",
  interrupted: "已中斷",
} as const;

export function providerGuidance(health: ProviderHealth): string | null {
  if (health.state === "ready") return null;
  if (health.state === "missing") return `請安裝支援版本，或手動選擇 ${health.provider === "claude" ? "Claude" : "Codex"} CLI。`;
  if (health.state === "incompatible") return "請確認 CLI 版本與本機安全設定符合這個版本的支援範圍。";
  if (health.state === "unauthenticated") return "請先在終端機登入官方訂閱帳號，再回來重新檢查。";
  return health.provider === "claude"
    ? "此版本尚未開放 Claude 執行。"
    : "此版本尚未開放 Codex 執行。";
}

export function roomEventLabel(event: RoomEvent): string {
  switch (event.type) {
    case "message.posted": return event.payload.body;
    case "task.created": return "已建立代理任務";
    case "task.transitioned": return `任務狀態：${TASK_STATE_LABEL[event.payload.from]} → ${TASK_STATE_LABEL[event.payload.to]}`;
    case "approval.requested": return "需要你的核准";
    case "approval.decided": return event.payload.receipt.decision === "approved" ? "已核准" : "已拒絕";
    case "agent.run": return "代理執行狀態已更新";
    case "checkpoint.created": return "已建立不可變更的檢查點";
    case "review.started": return "已開始程式審查";
    case "review.completed": return "程式審查已完成";
    case "checkpoint.integrated": return "檢查點已整合";
    case "integration.conflict": return "整合時發現衝突";
    case "test.completed": return event.payload.result.exitCode === 0 ? "測試已通過" : "測試失敗";
    case "candidate.created": return "已建立可供核准的候選版本";
    case "task.interrupted": return "任務因工作程序中斷而暫停";
    case "task.recovery": return "已準備復原方案";
    case "merge.completed": return "候選版本已合併";
  }
}
