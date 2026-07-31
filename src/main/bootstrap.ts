import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog as electronDialog, ipcMain, shell } from "electron";
import {
  createElectronProjectDialog,
  createFixedProjectDialog,
  type ProjectDialogAdapter
} from "./dialog/project-dialog";
import { registerRendererGateway } from "./ipc/renderer-gateway";
import { installApplicationLifecycle } from "./lifecycle";
import { resolveRendererLocation } from "./renderer-location";
import { createWindowOptions } from "./window-options";
import { createWorkerSupervisor } from "./worker/supervisor";
import { installNavigationPolicy } from "./security/navigation-policy";
import { electronUtilityProcessAdapter } from "./worker/utility-process-adapter";
import { installE2EControls } from "./testing/e2e-controls";

declare const __BRANCHESTRA_PACKAGED_E2E__: boolean;

export interface BootstrapPaths {
  workerEntry: string;
  dbPath: string;
  preloadEntry: string;
  rendererEntry: string;
}

export interface E2EEnvironment {
  userDataPath: string;
  projectPath: string;
  mockScenario?: "two-round-success" | "interrupted-run";
  providerPaths: Partial<Record<"claude" | "codex", string>>;
}

const e2eEnvironmentNames = [
  "BRANCHESTRA_E2E",
  "BRANCHESTRA_E2E_USER_DATA",
  "BRANCHESTRA_E2E_PROJECT_PATH",
  "BRANCHESTRA_E2E_MOCK_SCENARIO",
  "BRANCHESTRA_E2E_CLAUDE_PATH",
  "BRANCHESTRA_E2E_CODEX_PATH"
] as const;

export function resolveE2EEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): E2EEnvironment | null {
  if (environment.BRANCHESTRA_E2E !== "1") return null;
  const userDataPath = environment.BRANCHESTRA_E2E_USER_DATA;
  const projectPath = environment.BRANCHESTRA_E2E_PROJECT_PATH;
  if (
    userDataPath === undefined
    || userDataPath.trim().length === 0
    || projectPath === undefined
    || projectPath.trim().length === 0
  ) {
    throw new Error("E2E requires nonempty user-data and project paths");
  }
  const scenario = environment.BRANCHESTRA_E2E_MOCK_SCENARIO;
  if (scenario !== undefined && scenario !== "two-round-success" && scenario !== "interrupted-run") {
    throw new Error("E2E mock scenario is invalid");
  }
  return {
    userDataPath,
    projectPath,
    providerPaths: {
      ...(environment.BRANCHESTRA_E2E_CLAUDE_PATH
        ? { claude: environment.BRANCHESTRA_E2E_CLAUDE_PATH }
        : {}),
      ...(environment.BRANCHESTRA_E2E_CODEX_PATH
        ? { codex: environment.BRANCHESTRA_E2E_CODEX_PATH }
        : {})
    },
    ...(scenario ? { mockScenario: scenario } : {})
  };
}

export function resolveBootstrapPaths(mainModuleUrl: string, userDataPath: string): BootstrapPaths {
  const mainDirectory = dirname(fileURLToPath(mainModuleUrl));
  return {
    workerEntry: join(mainDirectory, "worker.js"),
    dbPath: join(userDataPath, "branchestra.sqlite3"),
    preloadEntry: join(mainDirectory, "../preload/index.js"),
    rendererEntry: join(mainDirectory, "../renderer/index.html")
  };
}

export function bootstrapMain(): void {
  const e2eEnvironment = resolveE2EEnvironment(process.env);
  for (const name of e2eEnvironmentNames) delete process.env[name];
  let projectDialog: ProjectDialogAdapter;
  if (e2eEnvironment === null) {
    projectDialog = createElectronProjectDialog();
  } else {
    if (app.isPackaged && e2eEnvironment.mockScenario !== undefined && !__BRANCHESTRA_PACKAGED_E2E__) {
      throw new Error("MOCK_PROVIDER_DISABLED");
    }
    app.setPath("userData", e2eEnvironment.userDataPath);
    projectDialog = createFixedProjectDialog(e2eEnvironment.projectPath, e2eEnvironment.providerPaths);
  }
  const paths = resolveBootstrapPaths(import.meta.url, app.getPath("userData"));
  const supervisor = createWorkerSupervisor({
    utilityProcess: electronUtilityProcessAdapter,
    workerEntry: paths.workerEntry,
    dbPath: paths.dbPath,
    ownerInstanceId: randomUUID(),
    nextGeneration: randomUUID,
    restartBackoffMs: [100, 250, 500, 1000, 2000],
    schedule(delayMs, callback) {
      const timeout = setTimeout(callback, delayMs);
      return () => clearTimeout(timeout);
    },
    ...(e2eEnvironment?.mockScenario
      ? { e2eMockScenario: e2eEnvironment.mockScenario }
      : {})
  });
  installE2EControls({ BRANCHESTRA_E2E: e2eEnvironment ? "1" : undefined }, supervisor);
  let window: BrowserWindow | null = null;

  const createWindow = async (): Promise<BrowserWindow> => {
    const rendererLocation = resolveRendererLocation({
      isPackaged: app.isPackaged,
      rendererEntry: paths.rendererEntry,
      developmentUrl: process.env.ELECTRON_RENDERER_URL
    });
    const created = new BrowserWindow(createWindowOptions(paths.preloadEntry));
    window = created;
    const disposeGateway = registerRendererGateway({
      ipcMain,
      trustedWebContents: created.webContents,
      trustedRendererUrl: rendererLocation.url,
      parentWindow: created,
      dialog: projectDialog,
      supervisor,
      async confirmExternal(canonicalUrl) {
        const { response } = await electronDialog.showMessageBox(created, {
          type: "question",
          buttons: ["Open link", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          message: "Open this link in your default browser?",
          detail: canonicalUrl,
        });
        return response === 0;
      },
      openExternal: (canonicalUrl) => shell.openExternal(canonicalUrl),
    });
    let gatewayDisposed = false;
    const disposeWindowGateway = (): void => {
      if (gatewayDisposed) return;
      gatewayDisposed = true;
      disposeGateway();
    };
    installNavigationPolicy(created);
    created.once("ready-to-show", () => created.show());
    created.once("closed", () => {
      disposeWindowGateway();
      if (window === created) window = null;
    });
    try {
      if (rendererLocation.kind === "url") await created.loadURL(rendererLocation.url);
      else await created.loadFile(paths.rendererEntry);
    } catch (error) {
      disposeWindowGateway();
      if (!created.isDestroyed()) created.destroy();
      if (window === created) window = null;
      throw error;
    }
    return created;
  };

  installApplicationLifecycle({
    app,
    supervisor,
    createWindow,
    focusWindow() {
      if (window === null) return;
      if (window.isMinimized()) window.restore();
      window.focus();
    },
    quitTimeoutMs: 5_000,
    reportError(error) {
      console.error("Application lifecycle failure", error);
    }
  });
}
