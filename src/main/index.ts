import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { createWindowOptions } from "./window-options";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow(createWindowOptions(join(currentDirectory, "../preload/index.js")));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadFile(join(currentDirectory, "../renderer/index.html"));
  return window;
}

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
