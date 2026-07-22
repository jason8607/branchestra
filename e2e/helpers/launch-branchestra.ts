import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication } from "@playwright/test";

export interface LaunchBranchestraOptions {
  userDataPath: string;
  selectedProjectPath: string;
}

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export function launchBranchestra(
  options: LaunchBranchestraOptions
): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    BRANCHESTRA_E2E: "1",
    BRANCHESTRA_E2E_USER_DATA: options.userDataPath,
    BRANCHESTRA_E2E_PROJECT_PATH: options.selectedProjectPath
  };
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  return _electron.launch({ args: [workspaceRoot], env });
}
