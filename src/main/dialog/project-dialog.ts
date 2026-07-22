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
