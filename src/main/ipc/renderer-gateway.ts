import type { BrowserWindow, WebContents } from "electron";
import {
  RendererRequestEnvelopeSchema,
  WorkerEventEnvelopeSchema,
  WorkerRequestEnvelopeSchema,
  WorkerResponseEnvelopeSchema,
  ZERO_WORKER_GENERATION,
  assertEnvelopeSize,
  type WorkerRequestEnvelope
} from "../../shared/contracts/protocol";
import type { ProjectDialogAdapter } from "../dialog/project-dialog";
import type { WorkerSupervisor } from "../worker/supervisor";

interface IpcMainAdapter {
  handle(
    channel: string,
    listener: (event: { sender: { id: number } }, raw: unknown) => Promise<unknown>
  ): void;
  removeHandler(channel: string): void;
}

export interface RendererGatewayDependencies {
  ipcMain: IpcMainAdapter;
  trustedWebContents: Pick<WebContents, "id" | "send">;
  parentWindow: BrowserWindow;
  dialog: ProjectDialogAdapter;
  supervisor: Pick<WorkerSupervisor, "request" | "subscribe" | "getGeneration">;
}

export function registerRendererGateway(dependencies: RendererGatewayDependencies): () => void {
  dependencies.ipcMain.handle("branchestra:request", async (event, raw) => {
    if (event.sender.id !== dependencies.trustedWebContents.id) {
      throw new Error("Untrusted renderer sender");
    }

    assertEnvelopeSize(raw);
    const request = RendererRequestEnvelopeSchema.parse(raw);
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
          return WorkerResponseEnvelopeSchema.parse({
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
    const workerResponse = WorkerResponseEnvelopeSchema.parse(
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
    return WorkerResponseEnvelopeSchema.parse({
      ...workerResponse,
      payload: {
        ...workerResponse.payload,
        requestType: "project.pickExisting"
      }
    });
  });

  const unsubscribe = dependencies.supervisor.subscribe((raw) => {
    const parsed = WorkerEventEnvelopeSchema.safeParse(raw);
    if (parsed.success) {
      dependencies.trustedWebContents.send("branchestra:event", parsed.data);
    }
  });

  return () => {
    dependencies.ipcMain.removeHandler("branchestra:request");
    unsubscribe();
  };
}
