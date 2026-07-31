import { dialog, type BrowserWindow } from "electron";
import type { ProviderId } from "../../shared/contracts/provider";
import { pickDiagnosticDestination } from "../dialogs/save-dialog";

export interface ProjectDialogAdapter {
  pickExistingProject(parentWindow: BrowserWindow): Promise<string | null>;
  pickProviderExecutable?(parentWindow: BrowserWindow, provider: ProviderId): Promise<string | null>;
  pickDiagnosticDestination?(parentWindow: BrowserWindow): Promise<string | null>;
}

export function createElectronProjectDialog(): ProjectDialogAdapter {
  return {
    async pickExistingProject(parentWindow) {
      const result = await dialog.showOpenDialog(parentWindow, {
        title: "Add Existing Git Project",
        buttonLabel: "Add Project",
        properties: ["openDirectory", "dontAddToRecent"]
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async pickProviderExecutable(parentWindow, provider) {
      const name = provider === "claude" ? "Claude" : "Codex";
      const result = await dialog.showOpenDialog(parentWindow, {
        title: `Choose ${name} CLI`, buttonLabel: `Choose ${name} CLI`,
        properties: ["openFile", "dontAddToRecent"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    pickDiagnosticDestination
  };
}

export function createFixedProjectDialog(
  selectedPath: string,
  providerPaths: Partial<Record<ProviderId, string>> = {},
  diagnosticDestination?: string
): ProjectDialogAdapter {
  if (selectedPath.length === 0) throw new Error("E2E project path is empty");
  return {
    pickExistingProject: async () => selectedPath,
    pickProviderExecutable: async (_parentWindow, provider) => providerPaths[provider] ?? null,
    pickDiagnosticDestination: async () => diagnosticDestination ?? null
  };
}
