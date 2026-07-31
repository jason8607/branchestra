import rawProviderPolicy from "../../../config/provider-policy.json";
import { ProviderPolicySchema } from "../contracts/provider-policy";

const providerPolicy = ProviderPolicySchema.parse(rawProviderPolicy);
export const PUBLIC_PROVIDER_RELEASE_POLICY = Object.freeze({
  claudeSubscription: Object.freeze({
    enabled: providerPolicy.publicFeatures.claudeSubscription,
    writtenApproval: providerPolicy.providers.claude.policyEvidence?.kind === "written_approval"
      ? providerPolicy.providers.claude.policyEvidence.path : null,
  }),
  codexSubscription: Object.freeze({
    enabled: providerPolicy.publicFeatures.codexSubscription,
    policyStatus: providerPolicy.providers.codex.status,
  }),
});
