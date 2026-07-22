import type { RendererCommand, WorkerEventEnvelope, WorkerResponseEnvelope } from "./protocol";

export interface BranchestraApi {
  request(command: RendererCommand): Promise<WorkerResponseEnvelope>;
  subscribe(listener: (event: WorkerEventEnvelope) => void): () => void;
}

declare global {
  interface Window {
    branchestra: BranchestraApi;
  }
}
