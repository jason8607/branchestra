import React from "react";
import type { RoomCleanupPreview } from "../../../shared/contracts/protocol";
import type { WorktreeCleanupPreview } from "../../../shared/contracts/protocol";
import type { ProjectCleanupPreview } from "../../../shared/contracts/protocol";
import type { WorktreeRecord } from "../../../shared/contracts/domain";

export function DataManagementPanel(props: {
  roomId: string | null;
  projectId: string | null;
  preview: RoomCleanupPreview | null;
  confirmation: string;
  pending: boolean;
  worktrees: readonly WorktreeRecord[];
  worktreePreview: WorktreeCleanupPreview | null;
  allowDirtyArchive: boolean;
  projectPreview: ProjectCleanupPreview | null;
  projectConfirmation: string;
  onConfirmation(value: string): void;
  onPreviewRoom(): void;
  onRemoveRoom(): void;
  onPreviewWorktree(worktreeId: string): void;
  onAllowDirtyArchive(value: boolean): void;
  onArchiveWorktree(): void;
  onProjectConfirmation(value: string): void;
  onPreviewProject(): void;
  onRemoveProject(): void;
}): React.JSX.Element {
  return <section aria-labelledby="data-management-title">
    <h2 id="data-management-title">資料管理</h2>
    <p>這裡只會移除選取的 Branchestra 本機資料，不會刪除 Git 儲存庫、分支、Git 物件或代理帳號。</p>
    <p>除非另有檔案系統或 Time Machine 備份，否則移除後無法復原。</p>
    {props.roomId ? <>
      <button className="danger-button" type="button" disabled={props.pending} onClick={props.onPreviewRoom}>移除房間本機資料</button>
      {props.preview ? <>
        <p>將移除 {props.preview.eventCount} 個事件與 {props.preview.activeTaskCount} 個任務。</p>
        <label>輸入下列文字確認<input placeholder={`DELETE ${props.roomId}`} value={props.confirmation} onChange={(event) => props.onConfirmation(event.target.value)} /></label>
        <button className="danger-button" type="button" disabled={props.pending || props.confirmation !== `DELETE ${props.roomId}`} onClick={props.onRemoveRoom}>確認移除本機資料</button>
      </> : null}
    </> : <p>選擇房間後即可管理它的本機資料。</p>}
    {props.worktrees.map((worktree) => (
      <button key={worktree.id} type="button" disabled={props.pending}
        onClick={() => props.onPreviewWorktree(worktree.id)}>
        封存 {worktree.role} worktree
      </button>
    ))}
    {props.worktreePreview ? <>
      <p>{props.worktreePreview.dirtyHash
        ? "這個 worktree 含有未提交內容，需要明確確認後才能封存。"
        : "這個 worktree 沒有未提交內容，將保留在復原目錄。"}</p>
      {props.worktreePreview.dirtyHash ? <label>
        <input type="checkbox" checked={props.allowDirtyArchive}
          onChange={(event) => props.onAllowDirtyArchive(event.target.checked)} />
        一併封存未提交的 worktree 內容
      </label> : null}
      <button type="button"
        disabled={props.pending || (props.worktreePreview.dirtyHash !== null && !props.allowDirtyArchive)}
        onClick={props.onArchiveWorktree}>確認封存 worktree</button>
    </> : null}
    {props.projectId ? <>
      <button className="danger-button" type="button" disabled={props.pending} onClick={props.onPreviewProject}>移除專案本機資料</button>
      {props.projectPreview ? <>
        <p>這個專案有 {props.projectPreview.roomCount} 個房間與 {props.projectPreview.activeTaskCount} 個任務。</p>
        <label>輸入下列文字確認移除專案資料<input
          placeholder={`DELETE ${props.projectId}`}
          value={props.projectConfirmation}
          onChange={(event) => props.onProjectConfirmation(event.target.value)} /></label>
        <button type="button"
          disabled={props.pending || props.projectConfirmation !== `DELETE ${props.projectId}`}
          onClick={props.onRemoveProject}>確認移除專案資料</button>
      </> : null}
    </> : null}
  </section>;
}
