import { useCallback, useEffect, useState } from "react";
import { TaskInspectorModelSchema, type TaskInspectorModel } from "../../../shared/contracts/domain";
import type { BranchestraApi } from "../../../shared/contracts/renderer-api";
import type { TaskWorkerCommand } from "../../../shared/contracts/protocol";

function eventTaskId(event: Parameters<Parameters<BranchestraApi["subscribe"]>[0]>[0]): string | null {
  if (event.type !== "room.event") return null;
  const payload = event.payload.payload;
  if (typeof payload !== "object" || payload === null) return null;
  if ("taskId" in payload && typeof payload.taskId === "string") return payload.taskId;
  if ("task" in payload && typeof payload.task === "object" && payload.task !== null
    && "id" in payload.task && typeof payload.task.id === "string") return payload.task.id;
  if ("candidate" in payload && typeof payload.candidate === "object" && payload.candidate !== null
    && "taskId" in payload.candidate && typeof payload.candidate.taskId === "string") return payload.candidate.taskId;
  if ("request" in payload && typeof payload.request === "object" && payload.request !== null
    && "taskId" in payload.request && typeof payload.request.taskId === "string") return payload.request.taskId;
  return null;
}

export function useTaskInspector(api: BranchestraApi, taskId: string | null): {
  model: TaskInspectorModel | null;
  pending: boolean;
  error: string | null;
  request(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
} {
  const [model, setModel] = useState<TaskInspectorModel | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async (command: TaskWorkerCommand): Promise<TaskInspectorModel> => {
    setPending(true);
    setError(null);
    try {
      const response = await api.request({
        ...command,
        idempotencyKey: crypto.randomUUID()
      });
      if (!response.payload.ok) throw new Error(response.payload.message);
      const parsed = TaskInspectorModelSchema.safeParse(response.payload.data);
      if (!parsed.success) throw new Error("Task Inspector response is invalid");
      setModel(parsed.data);
      return parsed.data;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to load task";
      setError(message);
      throw cause;
    } finally {
      setPending(false);
    }
  }, [api]);

  useEffect(() => {
    if (taskId === null) {
      setModel(null);
      setError(null);
      return;
    }
    let active = true;
    void request({ type: "task.get", payload: { taskId } }).catch(() => undefined);
    const unsubscribe = api.subscribe((event) => {
      if (!active) return;
      if (event.type === "worker.ready" || event.type === "state.invalidated"
        || eventTaskId(event) === taskId) {
        void request({ type: "task.get", payload: { taskId } }).catch(() => undefined);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, request, taskId]);

  return { model, pending, error, request };
}
