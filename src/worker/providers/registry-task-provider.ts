import type { TaskProviderPort, TaskProviderResumeRequest, TaskProviderRunHandle, TaskProviderRunRequest } from "../tasks/provider-port";
import type { ProviderRegistry } from "./provider-registry";

export class RegistryTaskProvider implements TaskProviderPort {
  private readonly activeProvider = new Map<string, "claude" | "codex">();
  constructor(private readonly registry: ProviderRegistry) {}

  startRun(request: TaskProviderRunRequest): Promise<TaskProviderRunHandle> {
    return this.start(request, false);
  }

  resumeRun(request: TaskProviderResumeRequest): Promise<TaskProviderRunHandle> {
    return this.start(request, true);
  }

  async cancelRun(runId: string, reason: "user" | "quit" | "timeout"): Promise<void> {
    const provider = this.activeProvider.get(runId);
    if (!provider) return;
    await this.registry.requireRunnable(provider).cancelRun(runId, reason);
  }

  private async start(request: TaskProviderRunRequest | TaskProviderResumeRequest, resume: boolean): Promise<TaskProviderRunHandle> {
    const adapter = this.registry.requireRunnable(request.provider);
    this.activeProvider.set(request.runId, request.provider);
    try {
      const handle = resume
        ? await adapter.resumeRun(request as TaskProviderResumeRequest)
        : await adapter.startRun(request);
      void handle.completion.finally(() => this.activeProvider.delete(request.runId));
      return handle;
    } catch (error) {
      this.activeProvider.delete(request.runId);
      throw error;
    }
  }
}
