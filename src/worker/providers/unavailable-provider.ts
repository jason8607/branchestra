import type { TaskProviderPort, TaskProviderRunHandle } from "../tasks/provider-port";

export class UnavailableProvider implements TaskProviderPort {
  startRun(): Promise<TaskProviderRunHandle> {
    return Promise.reject(new Error("PROVIDER_UNAVAILABLE"));
  }

  resumeRun(): Promise<TaskProviderRunHandle> {
    return Promise.reject(new Error("PROVIDER_UNAVAILABLE"));
  }

  cancelRun(): Promise<void> {
    return Promise.reject(new Error("PROVIDER_UNAVAILABLE"));
  }
}

export function createDefaultTaskProvider(): TaskProviderPort {
  return new UnavailableProvider();
}
