import { describe, expect, it, vi } from "vitest";
import { BrowserWindow, dialog as electronDialog, ipcMain } from "electron";
import { bootstrapMain } from "../../src/main/bootstrap";
import { createElectronProjectDialog } from "../../src/main/dialog/project-dialog";
import { registerRendererGateway } from "../../src/main/ipc/renderer-gateway";
import { installApplicationLifecycle } from "../../src/main/lifecycle";
import { createWorkerSupervisor } from "../../src/main/worker/supervisor";
import {
  MAX_IPC_BYTES,
  WorkerResponseEnvelopeSchema,
  type WorkerRequestEnvelope,
  type WorkerResponseEnvelope
} from "../../src/shared/contracts/protocol";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/data/user") },
  BrowserWindow: vi.fn(),
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  utilityProcess: { fork: vi.fn() }
}));

vi.mock("../../src/main/lifecycle", () => ({
  installApplicationLifecycle: vi.fn()
}));

vi.mock("../../src/main/worker/supervisor", () => ({
  createWorkerSupervisor: vi.fn()
}));

vi.mock("../../src/main/worker/utility-process-adapter", () => ({
  electronUtilityProcessAdapter: {}
}));

const generation = "50000000-0000-4000-8000-000000000001";

function workerResponse(request: WorkerRequestEnvelope): WorkerResponseEnvelope {
  const data = (() => {
    switch (request.type) {
      case "state.getSnapshot":
        return { projects: [], rooms: [], roomCursors: {} };
      case "room.replay":
        return {
          roomId: request.payload.roomId,
          events: [],
          nextRoomSeq: request.payload.roomSeq,
          hasMore: false
        };
      case "room.create":
        return {
          id: "20000000-0000-4000-8000-000000000002",
          projectId: request.payload.projectId,
          title: request.payload.title,
          createdAt: "2026-07-21T00:00:00.000Z"
        };
      case "message.post":
        return {
          id: "20000000-0000-4000-8000-000000000003",
          roomId: request.payload.roomId,
          roomSeq: 1,
          type: "message.posted" as const,
          actor: "user" as const,
          payload: {
            id: "20000000-0000-4000-8000-000000000004",
            roomId: request.payload.roomId,
            body: request.payload.body,
            createdAt: "2026-07-21T00:00:00.000Z"
          },
          createdAt: "2026-07-21T00:00:00.000Z"
        };
      case "project.addExisting":
        return {
          id: "20000000-0000-4000-8000-000000000001",
          repositoryRoot: request.payload.selectedPath,
          gitCommonDir: `${request.payload.selectedPath}/.git`,
          displayName: "main",
          headOid: "a".repeat(40),
          defaultBranch: "main",
          createdAt: "2026-07-21T00:00:00.000Z"
        };
      case "worker.prepareQuit":
        return { prepared: true as const };
    }
  })();
  return WorkerResponseEnvelopeSchema.parse({
    v: 1 as const,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    workerGeneration: request.workerGeneration,
    type: "response" as const,
    payload: {
      ok: true as const,
      requestType: request.type,
      data,
      replayed: false
    }
  });
}

function validSnapshotRequest(workerGeneration = generation) {
  return {
    v: 1,
    requestId: "10000000-0000-4000-8000-000000000001",
    idempotencyKey: "snapshot-1",
    workerGeneration,
    type: "state.getSnapshot",
    payload: {}
  };
}

function gatewayFixture(options: {
  selectedPath: string | null;
  senderId: number;
  activeGeneration?: string | null;
  responseTransform?: (response: WorkerResponseEnvelope) => WorkerResponseEnvelope;
}) {
  type Handler = (event: { sender: { id: number } }, raw: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  };
  const dialog = {
    pickExistingProject: vi.fn(async () => options.selectedPath)
  };
  let eventListener: ((event: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  const supervisor = {
    request: vi.fn(async (request: WorkerRequestEnvelope) => {
      const response = workerResponse(request);
      return options.responseTransform?.(response) ?? response;
    }),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      eventListener = listener;
      return unsubscribe;
    }),
    getGeneration: vi.fn(() => (
      "activeGeneration" in options ? options.activeGeneration! : generation
    ))
  };
  const trustedWebContents = { id: options.senderId, send: vi.fn() };
  const parentWindow = {} as BrowserWindow;
  return {
    generation,
    ipcMain,
    dialog,
    supervisor,
    trustedWebContents,
    unsubscribe,
    dependencies: { ipcMain, trustedWebContents, parentWindow, dialog, supervisor },
    async invoke(senderId: number, raw: unknown): Promise<unknown> {
      const handler = handlers.get("branchestra:request");
      if (!handler) throw new Error("Renderer request handler is not registered");
      return handler({ sender: { id: senderId } }, raw);
    },
    emitEvent(event: unknown): void {
      eventListener?.(event);
    }
  };
}

describe("renderer gateway", () => {
  it("opens an injected parent-scoped directory picker and returns Main's selected path", async () => {
    vi.mocked(electronDialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/selected/by/electron"]
    });
    const parentWindow = {} as Parameters<ReturnType<typeof createElectronProjectDialog>["pickExistingProject"]>[0];

    await expect(createElectronProjectDialog().pickExistingProject(parentWindow)).resolves.toBe(
      "/selected/by/electron"
    );
    expect(electronDialog.showOpenDialog).toHaveBeenCalledWith(parentWindow, {
      title: "Add Existing Git Project",
      buttonLabel: "Add Project",
      properties: ["openDirectory", "dontAddToRecent"]
    });
  });

  it("translates an empty project picker request using the injected Main dialog", async () => {
    const fixture = gatewayFixture({ selectedPath: "/selected/by/main", senderId: 42 });
    registerRendererGateway(fixture.dependencies);
    const response = await fixture.invoke(42, {
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "pick-1",
      workerGeneration: fixture.generation,
      type: "project.pickExisting",
      payload: {}
    });

    expect(fixture.dialog.pickExistingProject).toHaveBeenCalledOnce();
    expect(fixture.supervisor.request).toHaveBeenCalledWith(expect.objectContaining({
      type: "project.addExisting",
      payload: { selectedPath: "/selected/by/main" }
    }));
    expect(response).toMatchObject({ payload: { ok: true, requestType: "project.pickExisting" } });
  });

  it("rejects an untrusted sender without showing a dialog or dispatching", async () => {
    const fixture = gatewayFixture({ selectedPath: "/selected/by/main", senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(99, validSnapshotRequest())).rejects.toThrow("Untrusted renderer sender");
    expect(fixture.dialog.pickExistingProject).not.toHaveBeenCalled();
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it("rejects sender identity before inspecting an oversized envelope", async () => {
    const fixture = gatewayFixture({ selectedPath: "/selected/by/main", senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(99, { body: "x".repeat(MAX_IPC_BYTES) })).rejects.toThrow(
      "Untrusted renderer sender"
    );
    expect(fixture.dialog.pickExistingProject).not.toHaveBeenCalled();
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it("rejects oversized input before schema, dialog, or worker side effects", async () => {
    const fixture = gatewayFixture({ selectedPath: "/selected/by/main", senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, { body: "x".repeat(MAX_IPC_BYTES) })).rejects.toThrow(
      "IPC envelope exceeds"
    );
    expect(fixture.dialog.pickExistingProject).not.toHaveBeenCalled();
    expect(fixture.supervisor.getGeneration).not.toHaveBeenCalled();
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it("rejects malformed input before dialog or worker side effects", async () => {
    const fixture = gatewayFixture({ selectedPath: "/selected/by/main", senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, { nope: true })).rejects.toThrow();
    expect(fixture.dialog.pickExistingProject).not.toHaveBeenCalled();
    expect(fixture.supervisor.getGeneration).not.toHaveBeenCalled();
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it("stamps the active generation onto a zero-generation snapshot bootstrap", async () => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, validSnapshotRequest(
      "00000000-0000-0000-0000-000000000000"
    ))).resolves.toMatchObject({ workerGeneration: fixture.generation });
    expect(fixture.supervisor.request).toHaveBeenCalledWith(expect.objectContaining({
      workerGeneration: fixture.generation,
      type: "state.getSnapshot",
      payload: {}
    }));
  });

  it("rejects requests while no worker generation is ready", async () => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42, activeGeneration: null });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, validSnapshotRequest())).rejects.toThrow("Worker is not ready");
    expect(fixture.dialog.pickExistingProject).not.toHaveBeenCalled();
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it("rejects a nonzero generation that does not match the active worker", async () => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, validSnapshotRequest(
      "50000000-0000-4000-8000-000000000099"
    ))).rejects.toThrow("Stale worker generation");
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it("rejects zero generation for non-snapshot requests", async () => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, {
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "room-1",
      workerGeneration: "00000000-0000-0000-0000-000000000000",
      type: "room.create",
      payload: {
        projectId: "20000000-0000-4000-8000-000000000001",
        title: "Room"
      }
    })).rejects.toThrow();
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it.each([
    ["state.getSnapshot", {}],
    ["room.replay", {
      roomId: "20000000-0000-4000-8000-000000000001",
      roomSeq: 0,
      limit: 100
    }],
    ["room.create", {
      projectId: "20000000-0000-4000-8000-000000000001",
      title: "Room"
    }],
    ["message.post", {
      roomId: "20000000-0000-4000-8000-000000000001",
      body: "Hello"
    }]
  ] as const)("maps only the explicit %s worker command", async (type, payload) => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await fixture.invoke(42, {
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "mapped-1",
      workerGeneration: fixture.generation,
      type,
      payload
    });

    expect(fixture.supervisor.request).toHaveBeenCalledWith(expect.objectContaining({ type, payload }));
  });

  it.each(["selectedPath", "filePath", "executable", "argv", "shellText"])(
    "rejects renderer path or process injection key %s",
    async (injectedKey) => {
      const fixture = gatewayFixture({ selectedPath: "/selected/by/main", senderId: 42 });
      registerRendererGateway(fixture.dependencies);

      await expect(fixture.invoke(42, {
        v: 1,
        requestId: "10000000-0000-4000-8000-000000000001",
        idempotencyKey: "pick-1",
        workerGeneration: fixture.generation,
        type: "project.pickExisting",
        payload: { [injectedKey]: "/renderer/injected" }
      })).rejects.toThrow();
      expect(fixture.dialog.pickExistingProject).not.toHaveBeenCalled();
      expect(fixture.supervisor.request).not.toHaveBeenCalled();
    }
  );

  it("rejects arbitrary command strings instead of forwarding them", async () => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, {
      ...validSnapshotRequest(),
      type: "worker.prepareQuit",
      payload: { deadlineMs: 1 }
    })).rejects.toThrow();
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it("returns a schema-valid cancellation response without dispatching to Worker", async () => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42 });
    registerRendererGateway(fixture.dependencies);

    const response = await fixture.invoke(42, {
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "pick-1",
      workerGeneration: fixture.generation,
      type: "project.pickExisting",
      payload: {}
    });

    expect(() => WorkerResponseEnvelopeSchema.parse(response)).not.toThrow();
    expect(response).toMatchObject({
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "pick-1",
      workerGeneration: fixture.generation,
      type: "response",
      payload: {
        ok: true,
        requestType: "project.pickExisting",
        data: { cancelled: true },
        replayed: false
      }
    });
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });

  it("rejects an otherwise valid worker response that does not correlate to the request", async () => {
    const fixture = gatewayFixture({
      selectedPath: "/selected/by/main",
      senderId: 42,
      responseTransform: (response) => ({
        ...response,
        requestId: "10000000-0000-4000-8000-000000000099"
      })
    });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, {
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "pick-1",
      workerGeneration: fixture.generation,
      type: "project.pickExisting",
      payload: {}
    })).rejects.toThrow("Worker response correlation mismatch");
  });

  it("rewrites a schema-valid picker failure while preserving response correlation", async () => {
    const fixture = gatewayFixture({
      selectedPath: "/selected/by/main",
      senderId: 42,
      responseTransform: (response) => ({
        ...response,
        payload: {
          ok: false,
          requestType: "project.addExisting",
          code: "GIT_INVALID",
          message: "Not a repository"
        }
      })
    });
    registerRendererGateway(fixture.dependencies);

    await expect(fixture.invoke(42, {
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "pick-1",
      workerGeneration: fixture.generation,
      type: "project.pickExisting",
      payload: {}
    })).resolves.toMatchObject({
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "pick-1",
      workerGeneration: fixture.generation,
      payload: {
        ok: false,
        requestType: "project.pickExisting",
        code: "GIT_INVALID"
      }
    });
  });

  it("sends only schema-valid worker events on the renderer event channel", () => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42 });
    registerRendererGateway(fixture.dependencies);
    const validEvent = {
      v: 1,
      requestId: "30000000-0000-4000-8000-000000000001",
      idempotencyKey: "invalidate-1",
      workerGeneration: fixture.generation,
      type: "state.invalidated",
      payload: { roomId: null }
    };

    expect(() => fixture.emitEvent({ ...validEvent, extra: true })).not.toThrow();
    expect(fixture.trustedWebContents.send).not.toHaveBeenCalled();
    fixture.emitEvent(validEvent);

    expect(fixture.trustedWebContents.send).toHaveBeenCalledOnce();
    expect(fixture.trustedWebContents.send).toHaveBeenCalledWith("branchestra:event", validEvent);
  });

  it("registers one request handler and disposes the handler and event subscription", async () => {
    const fixture = gatewayFixture({ selectedPath: null, senderId: 42 });
    const dispose = registerRendererGateway(fixture.dependencies);

    expect(fixture.ipcMain.handle).toHaveBeenCalledOnce();
    expect(fixture.ipcMain.handle).toHaveBeenCalledWith(
      "branchestra:request",
      expect.any(Function)
    );
    expect(fixture.supervisor.subscribe).toHaveBeenCalledOnce();
    dispose();

    expect(fixture.ipcMain.removeHandler).toHaveBeenCalledOnce();
    expect(fixture.ipcMain.removeHandler).toHaveBeenCalledWith("branchestra:request");
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    await expect(fixture.invoke(42, validSnapshotRequest())).rejects.toThrow(
      "Renderer request handler is not registered"
    );
  });

  it("registers one gateway per bootstrap window and disposes it when that window closes", async () => {
    const windowListeners = new Map<string, () => void>();
    const fakeWindow = {
      webContents: {
        id: 42,
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn()
      },
      once: vi.fn((name: string, listener: () => void) => windowListeners.set(name, listener)),
      show: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      loadFile: vi.fn(async () => undefined),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      focus: vi.fn()
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return fakeWindow as unknown as BrowserWindow;
    });
    const unsubscribe = vi.fn();
    const supervisor = {
      start: vi.fn(),
      request: vi.fn(),
      subscribe: vi.fn(() => unsubscribe),
      stop: vi.fn(),
      getGeneration: vi.fn(() => generation)
    };
    vi.mocked(createWorkerSupervisor).mockReturnValueOnce(supervisor);

    bootstrapMain();
    const lifecycle = vi.mocked(installApplicationLifecycle).mock.calls[0]![0];
    await lifecycle.createWindow();

    expect(ipcMain.handle).toHaveBeenCalledWith("branchestra:request", expect.any(Function));
    expect(supervisor.subscribe).toHaveBeenCalledOnce();
    windowListeners.get("closed")?.();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("branchestra:request");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
