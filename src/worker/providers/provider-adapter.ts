import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderHealth,
  ProviderId,
} from "../../shared/contracts/provider";
import type { TaskProviderPort } from "../tasks/provider-port";

export interface ProviderAdapter extends TaskProviderPort {
  readonly provider: ProviderId;
  detect(): Promise<ProviderHealth>;
  probeCapabilities(executableRealpath: string): Promise<ProviderCapabilities>;
  getAuthStatus(executableRealpath: string): Promise<ProviderHealth["state"]>;
  normalizeEvent(raw: unknown, run: { runId: string; providerSeq: number; occurredAt: string }): ProviderEvent[];
}
