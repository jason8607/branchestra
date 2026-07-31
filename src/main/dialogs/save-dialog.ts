import { dialog, type BrowserWindow } from "electron";

export async function pickDiagnosticDestination(parentWindow: BrowserWindow): Promise<string | null> {
  const result = await dialog.showSaveDialog(parentWindow, {
    title: "Export Branchestra Diagnostics",
    buttonLabel: "Export diagnostics",
    defaultPath: "branchestra-diagnostics.json.gz",
    filters: [{ name: "Gzip JSON", extensions: ["gz"] }],
    properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"]
  });
  return result.canceled ? null : (result.filePath ?? null);
}
