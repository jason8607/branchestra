import type { IpcMainInvokeEvent } from "electron";
import { expect, it } from "vitest";
import { validateSender } from "../../../src/main/ipc/validated-sender";
import { assertEnvelopeSize } from "../../../src/shared/contracts/protocol";

function fake(input: { senderId: number; parent: object | null; url: string }): IpcMainInvokeEvent {
  return { sender: { id: input.senderId }, senderFrame: { parent: input.parent, url: input.url } } as unknown as IpcMainInvokeEvent;
}
it("rejects an encoded envelope larger than 64 KiB", () => {
  expect(() => assertEnvelopeSize({ payload: { text: "x".repeat(65_537) } })).toThrow("IPC envelope exceeds 65536 bytes");
});
it("rejects subframes and origins other than the URL loaded by Main", () => {
  expect(() => validateSender(fake({ senderId: 7, parent: {}, url: "https://evil.test" }), 7, "file:///Applications/Branchestra.app/Contents/Resources/app.asar/out/renderer/index.html"))
    .toThrow("Untrusted IPC sender");
});
