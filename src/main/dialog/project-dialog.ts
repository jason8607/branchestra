import { dialog, type BrowserWindow } from "electron";

export interface ProjectDialogAdapter {
  pickExistingProject(parentWindow: BrowserWindow): Promise<string | null>;
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
    }
  };
}

export function createFixedProjectDialog(selectedPath: string): ProjectDialogAdapter {
  if (selectedPath.length === 0) throw new Error("E2E project path is empty");
  return { pickExistingProject: async () => selectedPath };
}
