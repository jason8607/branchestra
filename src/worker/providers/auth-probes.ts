import { z } from "zod";
import type { ProviderId } from "../../shared/contracts/provider";
import type { ProviderExecPort } from "./provider-exec-port";

export type ProviderAuthDecision =
  | { state: "subscription"; display: string }
  | { state: "blocked" | "unknown" | "signed_out"; reason: string };

const ClaudeSubscriptionSchema = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal("claude.ai"),
  subscriptionType: z.string().optional(),
}).passthrough();

export async function probeProviderAuth(input: {
  provider: ProviderId;
  executableRealpath: string;
  codexConfigLockRealpath?: string;
  env: Record<string, string>;
  runner: ProviderExecPort;
}): Promise<ProviderAuthDecision> {
  let args: string[];
  if (input.provider === "claude") {
    args = ["auth", "status", "--json"];
  } else {
    if (!input.codexConfigLockRealpath) return { state: "blocked", reason: "Validated Codex subscription config lock is required" };
    args = [
      "login", "status",
      "--config", `debug.config_lockfile.load_path=${JSON.stringify(input.codexConfigLockRealpath)}`,
      "--config", "debug.config_lockfile.allow_codex_version_mismatch=false",
    ];
  }
  let result: { stdout: string; stderr: string };
  try {
    result = await input.runner(input.executableRealpath, args, { env: input.env, timeoutMs: 5_000, maxBufferBytes: 65_536 });
  } catch {
    return { state: "signed_out", reason: `${input.provider} is not logged in` };
  }

  if (input.provider === "codex") {
    const recognizedStatuses = new Set(["Logged in using ChatGPT", "Logged in using an API key", "Not logged in"]);
    const status = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find((line) => recognizedStatuses.has(line));
    if (status === "Logged in using ChatGPT") return { state: "subscription", display: "ChatGPT" };
    if (status === "Logged in using an API key") return { state: "blocked", reason: "Unsupported Codex auth mode: api_key" };
    if (status === "Not logged in") return { state: "signed_out", reason: "codex is not logged in" };
    return { state: "unknown", reason: "Unrecognized Codex auth status" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { state: "unknown", reason: "Unrecognized Claude auth status" };
  }
  const subscription = ClaudeSubscriptionSchema.safeParse(parsed);
  if (subscription.success) {
    const type = subscription.data.subscriptionType;
    return { state: "subscription", display: type && ["free", "pro", "max"].includes(type) ? `Claude ${type[0]!.toUpperCase()}${type.slice(1)}` : "Claude" };
  }
  const signedOut = z.object({ loggedIn: z.literal(false) }).passthrough().safeParse(parsed);
  if (signedOut.success) return { state: "signed_out", reason: "claude is not logged in" };
  const mode = z.object({ authMethod: z.string() }).passthrough().safeParse(parsed);
  if (mode.success) return { state: "blocked", reason: `Unsupported Claude auth mode: ${mode.data.authMethod}` };
  return { state: "unknown", reason: "Unrecognized Claude auth status" };
}
