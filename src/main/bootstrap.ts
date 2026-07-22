import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { installApplicationLifecycle } from "./lifecycle";
import { createWindowOptions } from "./window-options";
import { createWorkerSupervisor } from "./worker/supervisor";
import { electronUtilityProcessAdapter } from "./worker/utility-process-adapter";

export interface BootstrapPaths {
  workerEntry: string;
  dbPath: string;
  preloadEntry: string;
  rendererEntry: string;
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
    const created = new BrowserWindow(createWindowOptions(paths.preloadEntry));
    window = created;
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.once("ready-to-show", () => created.show());
    created.once("closed", () => {
      if (window === created) window = null;
    });
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (developmentUrl !== undefined) await created.loadURL(developmentUrl);
    else await created.loadFile(paths.rendererEntry);
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
    quitTimeoutMs: 5_000
  });
}
