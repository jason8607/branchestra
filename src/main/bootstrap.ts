import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
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
import { electronUtilityProcessAdapter } from "./worker/utility-process-adapter";

export interface BootstrapPaths {
  workerEntry: string;
  dbPath: string;
  preloadEntry: string;
  rendererEntry: string;
}

export interface E2EEnvironment {
  userDataPath: string;
  projectPath: string;
}

const e2eEnvironmentNames = [
  "BRANCHESTRA_E2E",
  "BRANCHESTRA_E2E_USER_DATA",
  "BRANCHESTRA_E2E_PROJECT_PATH"
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
  return { userDataPath, projectPath };
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
    app.setPath("userData", e2eEnvironment.userDataPath);
    projectDialog = createFixedProjectDialog(e2eEnvironment.projectPath);
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
    }
  });
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
      supervisor
    });
    let gatewayDisposed = false;
    const disposeWindowGateway = (): void => {
      if (gatewayDisposed) return;
      gatewayDisposed = true;
      disposeGateway();
    };
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
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
