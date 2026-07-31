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
    <h2 id="data-management-title">Data management</h2>
    <p>This removes selected Branchestra metadata only. This does not delete your Git repository, branches, Git objects, or Provider account.</p>
    <p>Local metadata deletion is irreversible except for an external filesystem or Time Machine backup.</p>
    {props.roomId ? <>
      <button type="button" disabled={props.pending} onClick={props.onPreviewRoom}>Remove room metadata</button>
      {props.preview ? <>
        <p>{props.preview.eventCount} events and {props.preview.activeTaskCount} tasks will be removed.</p>
        <label>Type to confirm<input placeholder={`DELETE ${props.roomId}`} value={props.confirmation} onChange={(event) => props.onConfirmation(event.target.value)} /></label>
        <button type="button" disabled={props.pending || props.confirmation !== `DELETE ${props.roomId}`} onClick={props.onRemoveRoom}>Confirm local deletion</button>
      </> : null}
    </> : <p>Select a room to manage its local metadata.</p>}
    {props.worktrees.map((worktree) => (
      <button key={worktree.id} type="button" disabled={props.pending}
        onClick={() => props.onPreviewWorktree(worktree.id)}>
        Archive {worktree.role} worktree
      </button>
    ))}
    {props.worktreePreview ? <>
      <p>{props.worktreePreview.dirtyHash
        ? "This worktree has uncommitted bytes and requires explicit archive confirmation."
        : "This worktree is clean and will be retained in the recovery directory."}</p>
      {props.worktreePreview.dirtyHash ? <label>
        <input type="checkbox" checked={props.allowDirtyArchive}
          onChange={(event) => props.onAllowDirtyArchive(event.target.checked)} />
        Archive uncommitted worktree bytes
      </label> : null}
      <button type="button"
        disabled={props.pending || (props.worktreePreview.dirtyHash !== null && !props.allowDirtyArchive)}
        onClick={props.onArchiveWorktree}>Confirm worktree archive</button>
    </> : null}
    {props.projectId ? <>
      <button type="button" disabled={props.pending} onClick={props.onPreviewProject}>Remove project metadata</button>
      {props.projectPreview ? <>
        <p>{props.projectPreview.roomCount} rooms and {props.projectPreview.activeTaskCount} tasks belong to this project.</p>
        <label>Type to confirm project deletion<input
          placeholder={`DELETE ${props.projectId}`}
          value={props.projectConfirmation}
          onChange={(event) => props.onProjectConfirmation(event.target.value)} /></label>
        <button type="button"
          disabled={props.pending || props.projectConfirmation !== `DELETE ${props.projectId}`}
          onClick={props.onRemoveProject}>Confirm project metadata deletion</button>
      </> : null}
    </> : null}
  </section>;
}
