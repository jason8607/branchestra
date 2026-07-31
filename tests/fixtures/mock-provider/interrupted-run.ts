import type { TaskProviderRunRequest } from "../../../src/worker/tasks/provider-port";
import { e2eMockScript } from "../../../src/worker/providers/e2e-mock-scenarios";

export const interruptedRunScript = (request: TaskProviderRunRequest) =>
  e2eMockScript("interrupted-run", request);
