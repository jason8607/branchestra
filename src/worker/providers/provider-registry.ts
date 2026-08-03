import { EFFECTIVE_PROVIDER_POLICY } from "../../shared/config/effective-provider-policy";
import type { ProviderId } from "../../shared/contracts/provider";
import type { ProviderAdapter } from "./provider-adapter";

interface RegistryPolicy {
  claudeSubscription: { enabled: boolean };
  codexSubscription: { enabled: boolean };
}

export interface ProviderRegistryInput {
  policy: RegistryPolicy;
  createClaudeAdapter(): ProviderAdapter;
  createCodexAdapter(): ProviderAdapter;
}

export interface ProviderRegistry {
  get(provider: ProviderId): ProviderAdapter | null;
  requireRunnable(provider: ProviderId): ProviderAdapter;
}

export function createProviderRegistry(input?: ProviderRegistryInput): ProviderRegistry {
  const policy: RegistryPolicy = input?.policy ?? {
    claudeSubscription: { enabled: EFFECTIVE_PROVIDER_POLICY.claudeSubscription.enabled },
    codexSubscription: { enabled: EFFECTIVE_PROVIDER_POLICY.codexSubscription.enabled },
  };
  const adapters = new Map<ProviderId, ProviderAdapter>();
  if (input && policy.claudeSubscription.enabled) adapters.set("claude", input.createClaudeAdapter());
  if (input && policy.codexSubscription.enabled) adapters.set("codex", input.createCodexAdapter());
  return {
    get: (provider) => adapters.get(provider) ?? null,
    requireRunnable(provider) {
      const adapter = adapters.get(provider);
      if (adapter) return adapter;
      const label = provider === "claude" ? "Claude" : "Codex";
      if (!policy[`${provider}Subscription`].enabled) {
        throw new Error(`${label} subscription runs are disabled by public release policy`);
      }
      throw new Error(`Provider ${provider} is not ready`);
    },
  };
}
