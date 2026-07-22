import type { BrowserWindow, WebContents } from "electron";
import {
  RendererRequestEnvelopeSchema,
  WorkerEventEnvelopeSchema,
  WorkerRequestEnvelopeSchema,
  WorkerResponseEnvelopeSchema,
  ZERO_WORKER_GENERATION,
  assertEnvelopeSize,
  parseEnvelope,
  type WorkerRequestEnvelope
} from "../../shared/contracts/protocol";
import type { ProjectDialogAdapter } from "../dialog/project-dialog";
import type { WorkerSupervisor } from "../worker/supervisor";

interface IpcMainAdapter {
  handle(
    channel: string,
    listener: (event: { sender: { id: number }; senderFrame: { url: string } | null }, raw: unknown) => Promise<unknown>
  ): void;
  removeHandler(channel: string): void;
}

export interface RendererGatewayDependencies {
  ipcMain: IpcMainAdapter;
  trustedWebContents: Pick<WebContents, "id" | "send">;
  trustedRendererUrl: string;
  parentWindow: BrowserWindow;
  dialog: ProjectDialogAdapter;
  supervisor: Pick<WorkerSupervisor, "request" | "subscribe" | "getGeneration">;
}

export function registerRendererGateway(dependencies: RendererGatewayDependencies): () => void {
  dependencies.ipcMain.handle("branchestra:request", async (event, raw) => {
    if (event.sender.id !== dependencies.trustedWebContents.id) {
      throw new Error("Untrusted renderer sender");
    }
    if (event.senderFrame?.url !== dependencies.trustedRendererUrl) {
      throw new Error("Untrusted renderer frame");
    }

    assertEnvelopeSize(raw);
    const request = parseEnvelope(RendererRequestEnvelopeSchema, raw);
    const activeGeneration = dependencies.supervisor.getGeneration();
    if (activeGeneration === null) throw new Error("Worker is not ready");
    const isBootstrapSnapshot = request.type === "state.getSnapshot"
      && request.workerGeneration === ZERO_WORKER_GENERATION;
    if (!isBootstrapSnapshot && request.workerGeneration !== activeGeneration) {
      throw new Error("Stale worker generation");
    }

    let workerRequest: WorkerRequestEnvelope;
    switch (request.type) {
      case "project.pickExisting": {
        const selectedPath = await dependencies.dialog.pickExistingProject(dependencies.parentWindow);
        const generationAfterDialog = dependencies.supervisor.getGeneration();
        if (generationAfterDialog === null || generationAfterDialog !== activeGeneration) {
          throw new Error("Worker generation changed while project dialog was open");
        }
        if (selectedPath === null) {
          const cancelled = WorkerResponseEnvelopeSchema.parse({
            v: request.v,
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            workerGeneration: activeGeneration,
            type: "response",
            payload: {
              ok: true,
              requestType: "project.pickExisting",
              data: { cancelled: true },
              replayed: false
            }
          });
          assertEnvelopeSize(cancelled);
          return cancelled;
        }
        workerRequest = WorkerRequestEnvelopeSchema.parse({
          ...request,
          workerGeneration: activeGeneration,
          type: "project.addExisting",
          payload: { selectedPath }
        });
        break;
      }
      case "state.getSnapshot":
      case "room.replay":
      case "room.create":
      case "message.post":
        workerRequest = WorkerRequestEnvelopeSchema.parse({
          ...request,
          workerGeneration: activeGeneration
        });
        break;
    }
    const workerResponse = parseEnvelope(WorkerResponseEnvelopeSchema,
      await dependencies.supervisor.request(workerRequest)
    );
    if (
      workerResponse.requestId !== workerRequest.requestId
      || workerResponse.idempotencyKey !== workerRequest.idempotencyKey
      || workerResponse.workerGeneration !== workerRequest.workerGeneration
      || workerResponse.payload.requestType !== workerRequest.type
    ) {
      throw new Error("Worker response correlation mismatch");
    }
    if (request.type !== "project.pickExisting") return workerResponse;
    const rewritten = WorkerResponseEnvelopeSchema.parse({
      ...workerResponse,
      payload: {
        ...workerResponse.payload,
        requestType: "project.pickExisting"
      }
    });
    assertEnvelopeSize(rewritten);
    return rewritten;
  });

  const unsubscribe = dependencies.supervisor.subscribe((raw) => {
    try {
      assertEnvelopeSize(raw);
    } catch {
      return;
    }
    const parsed = WorkerEventEnvelopeSchema.safeParse(raw);
    if (parsed.success) {
      assertEnvelopeSize(parsed.data);
      dependencies.trustedWebContents.send("branchestra:event", parsed.data);
    }
  });

  return () => {
    dependencies.ipcMain.removeHandler("branchestra:request");
    unsubscribe();
  };
}
