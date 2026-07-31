import type { ProviderCapabilities, ProviderHealth, ProviderId } from "../../shared/contracts/provider";
import { PUBLIC_PROVIDER_RELEASE_POLICY } from "../../shared/config/provider-release-policy";
import type { ProviderExecPort } from "./provider-exec-port";
import { probeProviderAuth } from "./auth-probes";
import { discoverExternalExecutable } from "./executable-discovery";
import { buildProviderEnvironment } from "./provider-environment";

type LockDecision = { valid: true; realpath: string } | { valid: false; reason: string };

export interface ProviderHealthDependencies {
  repository: {
    getInstallation(provider: ProviderId): { executableRealpath: string } | undefined;
    upsertInstallation(record: {
      provider: ProviderId; executableRealpath: string; cliVersion: string; architecture: "arm64" | "x64";
      state: ProviderHealth["state"]; checkedAt: string;
    }): void;
  };
  runner: ProviderExecPort;
  host: {
    homeDirectory: string;
    temporaryDirectory: string;
    userName: string;
    architecture: "arm64" | "x64";
    resourcesRootRealpath: string;
  };
  validateCodexSubscriptionConfigLock(input: { resourcesRootRealpath: string; expectedCliVersion: string }): Promise<LockDecision>;
  now?: () => string;
}

const SDK_VERSION: Record<ProviderId, string> = { claude: "0.3.216", codex: "0.144.6" };
const CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  claude: {
    interactiveApproval: false, protocolInterrupt: true, processAbort: true, textDeltaStreaming: true,
    itemEventStreaming: false, sessionResume: true, workspaceWriteSandbox: true, toolNetworkControl: true, contextTools: "mcp",
  },
  codex: {
    interactiveApproval: false, protocolInterrupt: true, processAbort: true, textDeltaStreaming: false,
    itemEventStreaming: true, sessionResume: true, workspaceWriteSandbox: true, toolNetworkControl: true, contextTools: "injected",
  },
};

export class ProviderHealthService {
  constructor(private readonly deps: ProviderHealthDependencies) {}

  list(): Promise<ProviderHealth[]> {
    return Promise.all((["claude", "codex"] as const).map((provider) => this.refresh(provider)));
  }

  selectExecutable(provider: ProviderId, selectedPath: string): Promise<ProviderHealth> {
    return this.refresh(provider, selectedPath);
  }

  private async refresh(provider: ProviderId, selectedPath?: string): Promise<ProviderHealth> {
    const saved = this.deps.repository.getInstallation(provider);
    const detected = await discoverExternalExecutable({
      provider, selectedPath: selectedPath ?? saved?.executableRealpath ?? null,
      homeDirectory: this.deps.host.homeDirectory, architecture: this.deps.host.architecture, runner: this.deps.runner,
    });
    if (!detected) return this.health(provider, "missing", null, null, "Choose a supported official CLI executable.");
    if (provider === "claude" && !PUBLIC_PROVIDER_RELEASE_POLICY.claudeSubscription.enabled) {
      return this.persist(detected, "policy_disabled", "Public Claude runs require written Anthropic approval.");
    }
    if (provider === "codex" && (!PUBLIC_PROVIDER_RELEASE_POLICY.codexSubscription.enabled
      || PUBLIC_PROVIDER_RELEASE_POLICY.codexSubscription.policyStatus !== "allowed")) {
      return this.persist(detected, "policy_disabled", "Public Codex runs require current arm64 and x64 enforcement evidence.");
    }
    const env = buildProviderEnvironment({
      provider, executableRealpath: detected.executableRealpath, homeDirectory: this.deps.host.homeDirectory,
      temporaryDirectory: this.deps.host.temporaryDirectory, userName: this.deps.host.userName,
      approvedPathEntries: [], source: process.env,
    });
    let codexConfigLockRealpath: string | undefined;
    if (provider === "codex") {
      const lock = await this.deps.validateCodexSubscriptionConfigLock({
        resourcesRootRealpath: this.deps.host.resourcesRootRealpath, expectedCliVersion: detected.cliVersion,
      });
      if (!lock.valid) return this.persist(detected, "incompatible", lock.reason);
      codexConfigLockRealpath = lock.realpath;
    }
    const auth = await probeProviderAuth({
      provider, executableRealpath: detected.executableRealpath,
      ...(codexConfigLockRealpath ? { codexConfigLockRealpath } : {}), env, runner: this.deps.runner,
    });
    if (auth.state !== "subscription") return this.persist(detected, "unauthenticated", auth.reason);
    return this.persist(detected, "ready", null);
  }

  private persist(detected: { provider: ProviderId; executableRealpath: string; cliVersion: string; architecture: "arm64" | "x64" }, state: ProviderHealth["state"], repairAction: string | null): ProviderHealth {
    this.deps.repository.upsertInstallation({ ...detected, state, checkedAt: (this.deps.now ?? (() => new Date().toISOString()))() });
    return this.health(detected.provider, state, detected.executableRealpath, detected.cliVersion, repairAction);
  }

  private health(provider: ProviderId, state: ProviderHealth["state"], executableRealpath: string | null, cliVersion: string | null, repairAction: string | null): ProviderHealth {
    return {
      provider, state, executableRealpath, cliVersion, sdkVersion: SDK_VERSION[provider], architecture: this.deps.host.architecture,
      authLabel: "Subscription-only", capabilities: state === "ready" ? CAPABILITIES[provider] : null, repairAction,
    };
  }
}
