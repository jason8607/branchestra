import React from "react";

export function DataManagementPanel(props: {
  roomId: string | null; confirmation: string; onConfirmation(value: string): void; onRemoveRoom(): void;
}): React.JSX.Element {
  return <section aria-labelledby="data-management-title">
    <h2 id="data-management-title">Data management</h2>
    <p>This removes selected Branchestra metadata only. This does not delete your Git repository, branches, Git objects, or Provider account.</p>
    <p>Local metadata deletion is irreversible except for an external filesystem or Time Machine backup.</p>
    {props.roomId ? <>
      <label>Type to confirm<input value={props.confirmation} onChange={(event) => props.onConfirmation(event.target.value)} /></label>
      <button type="button" disabled={props.confirmation !== `DELETE ${props.roomId}`} onClick={props.onRemoveRoom}>Confirm local deletion</button>
    </> : <p>Select a room to manage its local metadata.</p>}
  </section>;
}
