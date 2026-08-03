import React from "react";

export function DiagnosticsPanel(props: { pending: boolean; onExport(): void }): React.JSX.Element {
  return <section aria-labelledby="diagnostics-title">
    <h2 id="diagnostics-title">診斷資料</h2>
    <p>匯出內容包含 App 與系統版本、已清理的代理狀態、任務數量，以及遮蔽敏感資訊後的近期錯誤。</p>
    <p>不包含訊息、原始碼、差異內容、原始代理事件、環境變數或登入資訊。</p>
    <button type="button" disabled={props.pending} onClick={props.onExport}>{props.pending ? "匯出中…" : "匯出診斷資料"}</button>
  </section>;
}
