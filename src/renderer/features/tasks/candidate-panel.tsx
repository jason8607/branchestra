import React from "react";
import type { TaskInspectorModel } from "../../../shared/contracts/domain";
import type { TaskWorkerCommand } from "../../../shared/contracts/protocol";

export function CandidatePanel(props: {
  model: TaskInspectorModel;
  request(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
}): React.JSX.Element | null {
  const { candidate, pendingApproval } = props.model;
  if (!candidate) return null;
  const finalRequest = pendingApproval?.kind === "final_merge" ? pendingApproval : null;
  return (
    <section className="task-panel" aria-label="整合候選版本">
      <h3>候選版本</h3>
      <p>變更 {candidate.diffSummary.filesChanged} 個檔案</p>
      <ul>{candidate.testResults.map((result) => (
        <li key={result.id}>{result.commandId} — {result.exitCode === 0 ? "通過" : "失敗"}</li>
      ))}</ul>
      {candidate.unresolved.map((finding, index) => <p key={`${finding.source}-${index}`}>{finding.summary}</p>)}
      {finalRequest ? (
        <button type="button" onClick={() => void props.request({
          type: "task.approveFinalMerge",
          payload: {
            taskId: props.model.task.id,
            approvalRequestId: finalRequest.id,
            targetRef: candidate.targetRef,
            baseOid: candidate.baseOid,
            candidateOid: candidate.candidateOid,
            diffHash: candidate.diffHash,
            testSetHash: candidate.testSetHash
          }
        })}>核准最終合併</button>
      ) : null}
    </section>
  );
}
