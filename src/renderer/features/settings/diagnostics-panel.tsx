import React from "react";

export function DiagnosticsPanel(props: { pending: boolean; onExport(): void }): React.JSX.Element {
  return <section aria-labelledby="diagnostics-title">
    <h2 id="diagnostics-title">Diagnostics</h2>
    <p>The export contains app/platform versions, sanitized Provider health, task-state counts, and redacted recent errors.</p>
    <p>It excludes messages, source files, diffs, raw Provider events, environment values, and authentication output.</p>
    <button type="button" disabled={props.pending} onClick={props.onExport}>{props.pending ? "Exporting…" : "Export diagnostics"}</button>
  </section>;
}
