import type { BrowserWindow } from "electron";

type ConfirmExternal = (url: string, userGestureNonce: string) => Promise<boolean>;
type OpenExternal = (url: string) => Promise<void>;
export async function openVerifiedExternal(rawUrl: string, userGestureNonce: string, confirmExternal: ConfirmExternal, openExternal: OpenExternal): Promise<void> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Only explicit HTTPS links can be opened"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Only explicit HTTPS links can be opened");
  if (!(await confirmExternal(url.href, userGestureNonce))) throw new Error("External link was not confirmed");
  await openExternal(url.href);
}
export function installNavigationPolicy(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
