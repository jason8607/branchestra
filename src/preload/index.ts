import { contextBridge, ipcRenderer } from "electron";
import { createPreloadApi } from "./api";

const api = createPreloadApi({
  invoke: (channel, value) => ipcRenderer.invoke(channel, value),
  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});

contextBridge.exposeInMainWorld("branchestra", api);
