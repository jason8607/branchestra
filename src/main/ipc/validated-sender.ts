import type { IpcMainInvokeEvent } from "electron";

export function validateSender(event: IpcMainInvokeEvent, expectedWebContentsId: number, allowedRendererUrl: string): void {
  const frame = event.senderFrame;
  const locationMatches = (() => {
    try {
      const actual = new URL(frame?.url ?? "invalid:");
      const allowed = new URL(allowedRendererUrl);
      return allowed.protocol === "file:"
        ? actual.protocol === "file:" && actual.pathname === allowed.pathname
        : actual.origin === allowed.origin && actual.pathname === allowed.pathname;
    } catch { return false; }
  })();
  if (event.sender.id !== expectedWebContentsId || !frame || frame.parent !== null || !locationMatches) {
    throw new Error("Untrusted IPC sender");
  }
}
