import { z } from "zod";

const EvidenceSchema = z.object({
  kind: z.enum(["official_documentation", "written_approval"]),
  path: z.string().regex(/^config\/provider-evidence\/[A-Za-z0-9._/-]+$/),
  scope: z.string().min(1),
}).strict();
const ProviderRecordSchema = z.object({
  status: z.enum(["blocked", "pending_evidence", "allowed", "approved"]),
  sdkVersion: z.string().min(1), cliVersion: z.string().min(1),
  reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), sourceUrl: z.string().url().startsWith("https://"),
  policyEvidence: EvidenceSchema.nullable(),
  enforcementReports: z.array(z.string().regex(/^config\/provider-evidence\/[A-Za-z0-9._/-]+\.json$/)),
}).strict();
export const ProviderPolicySchema = z.object({
  schemaVersion: z.literal(1),
  publicFeatures: z.object({ claudeSubscription: z.boolean(), codexSubscription: z.boolean() }).strict(),
  providers: z.object({ claude: ProviderRecordSchema, codex: ProviderRecordSchema }).strict(),
}).strict();
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;
