import { PUBLIC_PROVIDER_RELEASE_POLICY } from "./provider-release-policy";

declare const __BRANCHESTRA_PRIVATE_LOCAL_PROVIDERS__: boolean;

export interface EffectiveProviderPolicy {
  claudeSubscription: { enabled: boolean };
  codexSubscription: { enabled: boolean };
}

interface PublicProviderPolicy {
  claudeSubscription: { enabled: boolean };
  codexSubscription: { enabled: boolean; policyStatus: string };
}

export function resolveEffectiveProviderPolicy(
  publicPolicy: PublicProviderPolicy,
  privateLocalProviders: boolean,
): EffectiveProviderPolicy {
  return Object.freeze({
    claudeSubscription: Object.freeze({
      enabled: privateLocalProviders || publicPolicy.claudeSubscription.enabled,
    }),
    codexSubscription: Object.freeze({
      enabled: privateLocalProviders
        || (publicPolicy.codexSubscription.enabled && publicPolicy.codexSubscription.policyStatus === "allowed"),
    }),
  });
}

const privateLocalProviders = typeof __BRANCHESTRA_PRIVATE_LOCAL_PROVIDERS__ !== "undefined"
  && __BRANCHESTRA_PRIVATE_LOCAL_PROVIDERS__ === true;

export const EFFECTIVE_PROVIDER_POLICY = resolveEffectiveProviderPolicy(
  PUBLIC_PROVIDER_RELEASE_POLICY,
  privateLocalProviders,
);
